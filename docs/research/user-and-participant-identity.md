# How Graph and Slack identify the user and the participants of a conversation

Research for [#118](https://github.com/oyvindfanebust/rundown/issues/118), child of the map
[#117](https://github.com/oyvindfanebust/rundown/issues/117). The map replaces `NormalizedItem`
with typed records (`Email`, `ChatMessage`, `CalendarEvent`) that share a per-source `Person`
with an `isMe` flag the source sets in code. This note answers how each source can set that
flag, and fill the participant list, without the model inferring anything.

Every claim is cited to vendor documentation (learn.microsoft.com and the
`microsoftgraph/microsoft-graph-docs-contrib` source it is built from; docs.slack.dev) or to the
code on `main` at `ecfd2d8`. Where the vendor is silent or contradicts itself, that is stated.
Facts were gathered 2026-10-04.

## Verdict

**Graph:** fetch the user's own address set once per run with
`GET /me?$select=id,mail,userPrincipalName,proxyAddresses` under the `User.Read` scope rundown
already requests. "Me" is `mail`, `userPrincipalName` and every `smtp:`/`SMTP:` entry in
`proxyAddresses`, compared case-insensitively. Calendar `organizer` uses `isOrganizer` instead of
an address match. Cost: one extra request per run, no new scope.

**Slack:** the user id is already known (the cached `authed_user.id` from the OAuth exchange,
equal to `auth.test`'s `user_id`), so `isMe` on an author is a plain id comparison and costs
nothing. The 1:1 DM counterpart moves from the legacy `search.messages` `channel.name` behaviour
to `conversations.info` (`channel.user`), and group-DM members come from
`conversations.members`. Cost: one Tier 3 call per distinct DM and one Tier 4 call per distinct
group DM in the run, cached per run. New user scopes: `im:read` and `mpim:read`, which means an
app-config change, admin re-approval and a re-login for every user.

## 1. Microsoft Graph

### 1.1 What "me" is

`GET /me` returns the signed-in user. Its least-privileged delegated permission is `User.Read`,
which "allows the app to read the profile of signed-in users"
([user-get](https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0),
[permissions reference, User.Read](https://learn.microsoft.com/en-us/graph/permissions-reference#userread)).
By default it returns only `businessPhones, displayName, givenName, id, jobTitle, mail,
mobilePhone, officeLocation, preferredLanguage, surname, userPrincipalName`; other properties need
`$select` (same page).

The address-bearing properties, from the
[user resource](https://learn.microsoft.com/en-us/graph/api/resources/user?view=graph-rest-1.0):

| Property | What it is | Default? | Use for `isMe` |
|---|---|---|---|
| `mail` | "The SMTP address for the user." Defines the primary proxy address. | Yes | Yes. Can be null for accounts without a mailbox. |
| `userPrincipalName` | Sign-in name; "by convention, this value should map to the user's email name". | Yes | Yes, as a fallback. Convention only: it can differ from `mail`. |
| `proxyAddresses` | "A collection of addresses only relevant to the Microsoft Exchange server ... tied to a single mailbox." `SMTP:` (capital) is primary, `smtp:` secondary. Read-only in Graph. | No, needs `$select` | Yes. This is where aliases live. Keep only entries whose prefix is `smtp` (any case) and strip it. |
| `otherMails` | "A list of other email addresses for the user", up to 250. | No, needs `$select` | No. These are contact addresses, not addresses of this mailbox. The user-get page also names `User-Mail.ReadWrite.All` as least-privileged for reading it, so it may not even be readable under `User.Read`. |
| `imAddresses` | SIP addresses. | No | No. Not a mail address. |

The `mail`/`proxyAddresses` relationship is spelled out in the user resource's "mail and
proxyAddresses properties" section: changing `mail` recomputes `proxyAddresses` and makes the new
value primary; for Exchange-licensed users every proxy address belongs to a verified domain.

**Unverified:** no Graph page states in so many words that `User.Read` alone may `$select`
`proxyAddresses` on `/me`. `GET /me` lists `User.Read` as sufficient and the property carries no
special-permission note (unlike `otherMails`), so it is expected to work. Confirm with one call
against a real tenant before the build relies on it; if it is refused, `mail` +
`userPrincipalName` still cover the common case and aliases become a known gap.

The MSAL account `username` that `signedInAccount()` returns today
(`src/sources/graph/auth.ts`) is the UPN. It costs no call but misses aliases and any `mail` that
differs from the UPN, so it is not enough on its own.

### 1.2 Mail: how the fields map onto `Person`

From the [message resource](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0).
Every field is a `recipient` whose `emailAddress` is `{ name, address }`
([recipient](https://learn.microsoft.com/en-us/graph/api/resources/recipient?view=graph-rest-1.0),
[emailAddress](https://learn.microsoft.com/en-us/graph/api/resources/emailaddress?view=graph-rest-1.0)).

| Field | Meaning (vendor) | `Person` role |
|---|---|---|
| `from` | "The owner of the mailbox from which the message is sent." | Sender. |
| `sender` | "The account that is used to generate the message." Differs from `from` only in shared-mailbox or delegate sends. | Optional "sent on behalf by". |
| `toRecipients` | The To: recipients. | Recipients. |
| `ccRecipients` | The Cc: recipients. | Recipients (not selected today). |
| `bccRecipients` | The Bcc: recipients. | Only meaningful on the user's own sent mail. |
| `replyTo` | Addresses to use when replying. | Not a participant. |

`isMe` on each is an address match against the set from 1.1. The folder adds a check: on mail
from `SentItems`, `from` should match; a mismatch means the user sent as or on behalf of another
mailbox. When a delegate sends on behalf of an owner, "Outlook sets the **sender** property to the
delegate's account, and the **from** property remains as the mailbox owner"
([send messages, set the from and sender properties](https://learn.microsoft.com/en-us/graph/outlook-create-send-messages#set-the-from-and-sender-properties)).
So "did I write this" is `sender` matching the user, falling back to `from` when `sender` is
absent.

Absence is not evidence. Mail delivered through a distribution list carries the list's address
in To/Cc, not the user's, so no recipient is `isMe`. The typed record should not derive "addressed
to me" from the recipient list alone; the folder (`Inbox`) already says it was received.

### 1.3 Calendar: how the fields map onto `Person`

From the [event resource](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0),
[attendee](https://learn.microsoft.com/en-us/graph/api/resources/attendee?view=graph-rest-1.0) and
[responseStatus](https://learn.microsoft.com/en-us/graph/api/resources/responsestatus?view=graph-rest-1.0):

| Field | Meaning (vendor) | `Person` role |
|---|---|---|
| `organizer` | "The organizer of the event." | Organizer. |
| `isOrganizer` | True "if the calendar owner ... is the organizer of the event. It also applies if a delegate organized the event on behalf of the owner." | Sets `isMe` on the organizer without an address match. Not selected today. |
| `attendees[]` | `emailAddress`, `type` (`required`, `optional`, `resource`), `status` (a `responseStatus`). | Attendees, with their response. Resources are rooms and equipment, not people (the code already filters them). |
| `responseStatus` | The calendar owner's own response. | The user's response, already read as `extras.myResponse`. |

`responseStatus.response` is one of `none`, `organizer`, `tentativelyAccepted`, `accepted`,
`declined`, `notResponded`. The vendor warns that the value depends on whose calendar is read: an
attendee who has not responded shows `notResponded` in their own calendar and `none` in anyone
else's, and "Clients can treat `notResponded` == `none`." So other attendees' statuses as seen
from the user's copy are best-effort; the user's own response should come from the event's
top-level `responseStatus`, not from their entry in `attendees`.

`isMe` on an attendee is an address match against the set from 1.1.

### 1.4 Delegated and shared mailboxes

rundown reads `/me/calendarView` and `/me/mailFolders/{Inbox,SentItems}/messages`
(`src/sources/graph/index.ts`), so it sees only the signed-in user's own mailbox and primary
calendar. Reading another user's or a shared mailbox needs `Mail.Read.Shared` and a
`/users/{id}/...` path, and fails unless that mailbox was shared or delegated to the user
([shared or delegated folders](https://learn.microsoft.com/en-us/graph/outlook-share-messages-folders)).
That is out of scope for the map, and it keeps `isMe` simple: the address set belongs to the one
mailbox being read. Two edge cases remain inside scope:

- Mail the user sent as a shared mailbox (`sendAs`) has `from` set to the shared mailbox, which
  is not in the user's address set. With `sender` also selected, the source can still mark the
  user as the author.
- A meeting a delegate organized for the user has `isOrganizer: true` but an `organizer` address
  that may be the user's. Using `isOrganizer` rather than an address match handles both.

### 1.5 Changes against today's Graph code

- New call: `GET /me?$select=id,displayName,mail,userPrincipalName,proxyAddresses`, once per run
  (or once per `read()`), through the existing `fetchJson` seam. Graph throttling is per app per
  tenant and one extra GET per run is negligible against it.
- Scopes: none. `User.Read` is already in `GRAPH_SCOPES`.
- Mail `$select` gains `ccRecipients` and `sender` (and `bccRecipients` for `SentItems` if the
  spec wants it). `GraphMessage` gains the same fields.
- Calendar `$select` gains `isOrganizer`; attendee `status` is already returned inside
  `attendees` and only needs mapping.
- Address comparison is case-insensitive on the full address.

## 2. Slack

### 2.1 The user's own id

`auth.test` "checks authentication and tells 'you' who you are"; with a user token the response
carries `user_id` (and `user`, the handle). It needs no scope and allows "hundreds of requests per
minute" ([auth.test](https://docs.slack.dev/reference/methods/auth.test)). The OAuth v2 exchange
already returns the same id as `authed_user.id`
([oauth.v2.access](https://docs.slack.dev/reference/methods/oauth.v2.access)), and rundown caches
it next to the token (`src/sources/slack/auth.ts`, `CachedAuth.userId`) and uses it as `selfId`
for `fromMe` and the `from:<@id>` query (`src/sources/slack/index.ts`). `status()` already calls
`auth.test` but reads only `user`.

So `isMe` on a message author is `message.user === selfId`, with no extra call. Optionally the
source can call `auth.test` at the start of `read()` and use its `user_id`, which also catches a
token that was revoked or reissued for a different user; one cheap call.

### 2.2 1:1 DM counterpart

**Today:** `dmCounterpart` reads `channel.name` from the `search.messages` match and, if it looks
like a user id, resolves it with `users.info`. The vendor page says: "For IM results, the `type`
is set to `"im"` and the `channel.name` property contains the user ID of the target user"
([search.messages](https://docs.slack.dev/reference/methods/search.messages)). The same page
marks the method as "a legacy method" and recommends the Real-time Search API instead, and its
response example shows a `channel` object with `is_mpim` and `is_private` but no `is_im`, which
the code relies on for its `dm` type. ADR-0014's second amendment already treats this as a shape
to test for, not a guarantee.

**Documented replacement:** `conversations.info` on the DM's channel id. For a 1:1 DM the
response has `is_im: true` and `user`, which the conversation object documents as "The other
user's ID (DM-specific)"
([conversations.info](https://docs.slack.dev/reference/methods/conversations.info),
[conversation object](https://docs.slack.dev/reference/objects/conversation-object)).

- Rate limit: Tier 3, 50+ per minute.
- Scopes: user-token `channels:read`, `groups:read`, `im:read`, `mpim:read`; the Conversations
  API filters by type, so a DM needs only `im:read`
  ([using the Conversations API](https://docs.slack.dev/apis/web-api/using-the-conversations-api)).
- Cost: one call per distinct DM channel in the run, cached for the run. The id it returns is
  resolved to a name through the existing `users.info` cache (Tier 4, `users:read`), which in most
  runs already holds it because the counterpart authored some of the messages.

**Alternative:** `users.conversations?types=im` lists every DM the user is in, each with `user`,
at Tier 3 with up to 999 per page (200 recommended)
([users.conversations](https://docs.slack.dev/reference/methods/users.conversations)). It is one
call per 200 DMs regardless of activity, so it is cheaper only when a run touches more DMs than
the user has pages of DMs. A heavy user with years of DMs would page through all of them every
run. Per-channel `conversations.info` scales with what the run actually saw, so it is the better
default.

### 2.3 Group-DM members

`search.messages` gives a group DM an `mpdm-…` composite name. The documented examples show it
built from handles (`users.conversations` example: `"mpdm-mr.banks--slactions-jackson--beforebot-1"`),
not ids, and no page defines the format, so parsing it is guesswork; the code rightly leaves group
DMs unresolved today.

`conversations.members` returns the member ids of a conversation, cursor-paginated, at Tier 4
(100+ per minute), with the same four type-filtered scopes; a group DM needs `mpim:read`
([conversations.members](https://docs.slack.dev/reference/methods/conversations.members)). Group
DMs are small, so one page at `limit=200` covers each. Cost: one call per distinct group DM in
the run, plus `users.info` for members not already cached. The user appears in the list and gets
`isMe` by id.

`conversations.info` does not list members; for a DM it omits `num_members` since the count "is
constant" (conversation object). So 1:1 DMs use `conversations.info` and group DMs use
`conversations.members`.

### 2.4 Does `search.messages` already expose enough?

No. Per match it gives the author (`user`, `username`), the channel id, `is_mpim`/`is_private`,
and `channel.name`. That is enough for the author `Person` and its `isMe`, but:

- the 1:1 counterpart rests on legacy prose that contradicts the response example, and
- group-DM membership is not exposed at all.

The Real-time Search API the vendor now points to (`assistant.search.context`) does not close
the gap either. Its matches carry `author_user_id`, `channel_id` and `channel_name` but no
participant list; it needs a different scope family (`search:read.im`, `search:read.mpim`, and
others), a special rate limit, and the vendor asks callers to stay under 10 calls per user
inquiry ([assistant.search.context](https://docs.slack.dev/reference/methods/assistant.search.context)).
Migrating search is a separate decision and not needed for `isMe`.

### 2.5 Channels

Channel messages need no participant list: the `Person` is the author, with `isMe` by id. Members
of a public or private channel are not participants of a message in the sense the map uses, and
fetching them would need `channels:read`/`groups:read` and could be thousands of ids.

### 2.6 Rate-limit context

Limits are "per method, per workspace" with per-minute windows
([rate limits](https://docs.slack.dev/apis/web-api/rate-limits)). The May 2025 change that caps
`conversations.history` and `conversations.replies` hits commercially distributed,
non-Marketplace apps; "internal customer-built applications should not see rate limit changes"
(same page). rundown's app is an internal single-workspace install (ADR-0014 §5), and the methods
recommended here (`conversations.info`, `conversations.members`) are not in the capped set. A run
touching 30 DMs and 5 group DMs costs 30 Tier 3 calls and 5 Tier 4 calls, well inside a minute's
budget; the existing 429 handling (`Retry-After`) covers bursts.

### 2.7 Changes against today's Slack code

- `BASE_SCOPES` gains `im:read` and `mpim:read`. ADR-0014 §5 notes that re-login is enough only
  for scopes already inside the admin-approved `user_scope` ceiling. These two are not, so the
  Slack app config must add them, an admin must re-approve, and every user must run
  `rundown login` again. That is the main cost of the recommendation.
- `dmCounterpart` calls `conversations.info` (cached per run by channel id) and reads
  `channel.user`, instead of parsing `channel.name`. The `USER_ID` shape test and the legacy
  dependency go away.
- New per-run cache: group-DM channel id → member ids from `conversations.members`.
- Author `isMe` stays `user === selfId`; `fromMe` becomes `Person.isMe` on the author.
- Optionally `read()` takes `selfId` from a fresh `auth.test` rather than the cached
  `authed_user.id`.

## 3. Summary table

| Source | "Me" | Participants | New calls per run | New scopes |
|---|---|---|---|---|
| Graph mail | `mail`, `userPrincipalName`, `smtp:` entries of `proxyAddresses` | `from`, `sender`, `toRecipients`, `ccRecipients` (+`bccRecipients` on sent) | 1 (`GET /me`) | None (`User.Read`) |
| Graph calendar | Same address set; `isOrganizer` for the organizer | `organizer`, `attendees` with `status`; own response from `responseStatus` | Shared with mail | None |
| Slack channel | `user === selfId` | Author | 0 | None |
| Slack 1:1 DM | `user === selfId` | Author + `conversations.info` → `channel.user` | 1 per distinct DM (Tier 3) | `im:read` |
| Slack group DM | `user === selfId` | `conversations.members` | 1 per distinct group DM (Tier 4) | `mpim:read` |

## 4. Open points for the spec

- Confirm on a real tenant that `User.Read` returns `proxyAddresses` on `/me` (1.1).
- Decide whether `Email` carries `sender` separately from `from` or only uses it to set `isMe`
  on the author.
- Decide whether the Slack scope change ships with the typed-records build or as its own step,
  given it needs admin re-approval.
