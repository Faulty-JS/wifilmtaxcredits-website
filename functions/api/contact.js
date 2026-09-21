/**
 * Contact enquiries from the Wisconsin landing page.
 *
 * Fastmail over JMAP rather than SMTP. This is a Cloudflare Pages Function, so
 * it runs in a Workers isolate: outbound port 25 is blocked and SMTP's
 * stateful STARTTLS handshake is not something that runtime does reliably.
 * JMAP is plain HTTPS. The domain's SPF and DKIM already point at Fastmail, so
 * these send authenticated with no new DNS records.
 *
 * Sends two messages in one request: a notice to us with replyTo set to the
 * enquirer, so answering it reaches them; and an acknowledgement to them, so
 * the form does something visible rather than swallowing the message.
 *
 * Needs one secret on the Pages project:
 *   FASTMAIL_API_TOKEN  an API token with the mail and submission scopes. An
 *                       SMTP app password will NOT work; Fastmail scopes app
 *                       passwords per protocol.
 * Optional:
 *   MAIL_FROM           defaults to hello@wifilmtaxcredits.com. Must be an
 *                       address Fastmail lists as one of your identities.
 *   LEAD_TO             where the notice goes. Defaults to the from address.
 */

const JMAP_SESSION_URL = 'https://api.fastmail.com/jmap/session';
const DEFAULT_FROM = 'hello@wifilmtaxcredits.com';
const FROM_NAME = 'WI Film Tax Credits';
const MAX_NOTE = 4000;

const USING = [
    'urn:ietf:params:jmap:core',
    'urn:ietf:params:jmap:mail',
    'urn:ietf:params:jmap:submission',
];

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
        },
    });

async function openSession(token) {
    const res = await fetch(JMAP_SESSION_URL, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        throw new Error(
            res.status === 401
                ? 'Fastmail rejected the token. An SMTP app password will not work here; the token needs API access with the mail and submission scopes.'
                : `Fastmail session failed: ${res.status}`
        );
    }
    const session = await res.json();
    const accountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'];
    if (!session.apiUrl || !accountId) {
        throw new Error('Fastmail session did not name a mail account.');
    }
    return { apiUrl: session.apiUrl, accountId };
}

async function jmap(apiUrl, token, methodCalls) {
    const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ using: USING, methodCalls }),
    });
    if (!res.ok) {
        throw new Error(`JMAP request failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    const failed = body.methodResponses?.find(([name]) => name === 'error');
    if (failed) throw new Error(`JMAP error: ${JSON.stringify(failed[1])}`);
    return Object.fromEntries(body.methodResponses.map(([, result, id]) => [id, result]));
}

const leadText = (email, note) =>
    [
        `${email} got in touch through wifilmtaxcredits.com.`,
        '',
        note ? note : 'They did not leave any project details.',
        '',
        'Reply straight to this message and it goes to them.',
    ].join('\n');

const ackText = () =>
    [
        'Thanks for getting in touch.',
        '',
        'This part is automated. The reply you get will not be.',
        '',
        'Wisconsin returns 30% of qualified production spend, plus 100% of the sales and use tax you pay along the way. The per-applicant cap is $1 million a year out of a $5 million statewide allocation, so applying early genuinely matters.',
        '',
        'We will come back to you shortly. If anything changes about your dates or budget in the meantime, just reply here.',
        '',
        'WI Film Tax Credits',
        'hello@wifilmtaxcredits.com',
    ].join('\n');

export const onRequest = async (context) => {
    const { request, env } = context;

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Max-Age': '86400',
            },
        });
    }

    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    let email, note;
    try {
        ({ email, note } = await request.json());
    } catch {
        return json({ error: 'Invalid request body' }, 400);
    }

    if (!email) return json({ error: 'Missing email' }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: 'Invalid email format' }, 400);
    }
    note = typeof note === 'string' ? note.trim().slice(0, MAX_NOTE) : '';

    const token = env.FASTMAIL_API_TOKEN;
    if (!token) {
        console.error('[contact] FASTMAIL_API_TOKEN is not set');
        return json({ error: 'Email is not configured' }, 500);
    }

    const from = env.MAIL_FROM || DEFAULT_FROM;
    let stage = 'session';

    try {
        const { apiUrl, accountId } = await openSession(token);
        stage = 'lookup';

        const lookup = await jmap(apiUrl, token, [
            ['Identity/get', { accountId }, 'identities'],
            ['Mailbox/get', { accountId, properties: ['id', 'role'] }, 'mailboxes'],
        ]);

        stage = 'identity';
        const identity = lookup.identities.list.find(
            (i) => i.email.toLowerCase() === from.toLowerCase()
        );
        if (!identity) {
            const available = lookup.identities.list.map((i) => i.email).join(', ');
            throw new Error(
                `Fastmail has no identity for ${from}. Add it as an alias, or set MAIL_FROM to one of: ${available}`
            );
        }

        stage = 'mailboxes';
        const roleOf = (role) => lookup.mailboxes.list.find((m) => m.role === role)?.id;
        const drafts = roleOf('drafts');
        const sent = roleOf('sent');
        if (!drafts) throw new Error('Fastmail account has no drafts mailbox.');

        const filed = {
            [`mailboxIds/${drafts}`]: null,
            'keywords/$draft': null,
            ...(sent ? { [`mailboxIds/${sent}`]: true } : {}),
        };

        stage = 'send';
        const leadTo = env.LEAD_TO || from;
        const draft = (overrides) => ({
            from: [{ name: FROM_NAME, email: from }],
            keywords: { $draft: true },
            mailboxIds: { [drafts]: true },
            textBody: [{ partId: 'body', type: 'text/plain' }],
            ...overrides,
        });

        await jmap(apiUrl, token, [
            [
                'Email/set',
                {
                    accountId,
                    create: {
                        lead: draft({
                            to: [{ email: leadTo }],
                            replyTo: [{ email }],
                            subject: `Wisconsin enquiry: ${email}`,
                            bodyValues: {
                                body: { value: leadText(email, note), charset: 'utf-8' },
                            },
                        }),
                        ack: draft({
                            to: [{ email }],
                            replyTo: [{ name: FROM_NAME, email: from }],
                            subject: 'Thanks for getting in touch',
                            bodyValues: { body: { value: ackText(), charset: 'utf-8' } },
                        }),
                    },
                },
                'create',
            ],
            [
                'EmailSubmission/set',
                {
                    accountId,
                    onSuccessUpdateEmail: { '#notify': filed, '#reply': filed },
                    create: {
                        notify: { emailId: '#lead', identityId: identity.id },
                        reply: { emailId: '#ack', identityId: identity.id },
                    },
                },
                'submit',
            ],
        ]);

        return json({ success: true });
    } catch (err) {
        // Cloudflare replaces a 502 from a Pages Function with its own error
        // page, so the JSON never arrives. 500 passes through.
        console.error(`[contact] failed at ${stage}:`, err.message);
        return json({ error: 'Could not send the message', stage }, 500);
    }
};
