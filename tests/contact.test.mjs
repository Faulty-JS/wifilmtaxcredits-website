/**
 * The contact endpoint, driven through a stubbed Fastmail.
 *
 * Plain Node, no test runner: this repo is on vite 5 and the current vitest
 * needs vite 6, so adding one would mean a dependency upgrade for a single
 * test file. The assertions matter more than the harness.
 *
 * These check the JMAP call shapes, because a wrong creation id or a missing
 * capability fails at Fastmail rather than at deploy, and the only other way
 * to find out is to mail a stranger.
 */

import { readFileSync } from 'node:fs';
import { onRequest } from '../functions/api/contact.js';

let pass = 0, fail = 0;
const check = (name, actual, want) => {
    if (JSON.stringify(actual) === JSON.stringify(want)) { pass++; console.log(`PASS  ${name}`); }
    else { fail++; console.log(`FAIL  ${name}\n        got  ${JSON.stringify(actual)}\n        want ${JSON.stringify(want)}`); }
};

const SESSION = {
    apiUrl: 'https://api.fastmail.com/jmap/api/',
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct1' },
};
const IDENTITIES = {
    list: [
        { id: 'id-other', email: 'jake@prinemedia.com' },
        { id: 'id-hello', email: 'hello@wifilmtaxcredits.com' },
    ],
};
const MAILBOXES = {
    list: [
        { id: 'mb-drafts', role: 'drafts' },
        { id: 'mb-sent', role: 'sent' },
    ],
};

function stubFastmail({ sessionStatus = 200 } = {}) {
    const seen = [];
    globalThis.fetch = async (url, init) => {
        if (String(url).endsWith('/jmap/session')) {
            return new Response(JSON.stringify(SESSION), { status: sessionStatus });
        }
        const body = JSON.parse(init.body);
        seen.push(body);
        const methodResponses = body.methodCalls.map(([name, , id]) => {
            if (name === 'Identity/get') return ['Identity/get', IDENTITIES, id];
            if (name === 'Mailbox/get') return ['Mailbox/get', MAILBOXES, id];
            if (name === 'Email/set') return ['Email/set', { created: {} }, id];
            return ['EmailSubmission/set', { created: {} }, id];
        });
        return new Response(JSON.stringify({ methodResponses }), { status: 200 });
    };
    return seen;
}

const post = (body, env = { FASTMAIL_API_TOKEN: 'tok' }) =>
    onRequest({
        request: new Request('https://wifilmtaxcredits.com/api/contact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        env,
    });

const emailSet = (seen) => seen[1].methodCalls.find(([n]) => n === 'Email/set')[1].create;
const submission = (seen) => seen[1].methodCalls.find(([n]) => n === 'EmailSubmission/set')[1];

// --- guards before anything leaves the building --------------------------
check('rejects anything but POST',
    (await onRequest({ request: new Request('https://x/api/contact'), env: {} })).status, 405);

globalThis.fetch = () => { throw new Error('should not have been called'); };
check('rejects a missing address', (await post({})).status, 400);
check('rejects a malformed address', (await post({ email: 'nope' })).status, 400);
check('reports a configuration problem when the token is absent',
    (await post({ email: 'p@example.com' }, {})).status, 500);

// --- the happy path -------------------------------------------------------
let seen = stubFastmail();
const ok = await post({ email: 'producer@example.com', note: 'Feature, March, about $400k.' });
check('sends', ok.status, 200);
check('and says so', await ok.json(), { success: true });

const created = emailSet(seen);
check('creates both the notice and the acknowledgement',
    Object.keys(created).sort(), ['ack', 'lead']);
check('the notice comes to us', created.lead.to, [{ email: 'hello@wifilmtaxcredits.com' }]);
// Replying to the notice must reach the producer, not ourselves.
check('and replying to it reaches them', created.lead.replyTo, [{ email: 'producer@example.com' }]);
check('their note is carried into it',
    created.lead.bodyValues.body.value.includes('Feature, March, about $400k.'), true);
check('the acknowledgement goes to them', created.ack.to, [{ email: 'producer@example.com' }]);

const sub = submission(seen);
check('both submissions reference the right drafts',
    [sub.create.notify.emailId, sub.create.reply.emailId], ['#lead', '#ack']);
check('both are sent under the matching identity',
    [sub.create.notify.identityId, sub.create.reply.identityId], ['id-hello', 'id-hello']);
// A message left in drafts is a message that looks unsent.
check('and neither is left sitting in drafts',
    Object.keys(sub.onSuccessUpdateEmail).sort(), ['#notify', '#reply']);

check('declares the submission capability, or Fastmail refuses the call',
    seen.every((b) => b.using.includes('urn:ietf:params:jmap:submission')), true);

// --- an empty note is stated, not left blank ------------------------------
seen = stubFastmail();
await post({ email: 'producer@example.com' });
check('says so when no details were given',
    emailSet(seen).lead.bodyValues.body.value.includes('did not leave any project details'), true);

// --- failures ------------------------------------------------------------
// Cloudflare replaces a 502 from a Pages Function with its own error page.
stubFastmail({ sessionStatus: 401 });
const bad = await post({ email: 'p@example.com' });
check('a bad token is a 500, not a 502', bad.status, 500);
check('and names the stage without leaking the reason', await bad.json(),
    { error: 'Could not send the message', stage: 'session' });

// --- the page is wired to this endpoint ----------------------------------
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
check('the form posts here', html.includes("fetch('/api/contact'"), true);
check('the form asks for an email', html.includes('id="contact-email"'), true);
check('every input has a label', (html.match(/<label/g) || []).length >= 2, true);
check('no em dashes in the page', /—/.test(html), false);
check('robots points at this site, not Illinois',
    readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8')
        .includes('wifilmtaxcredits.com/sitemap.xml'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
