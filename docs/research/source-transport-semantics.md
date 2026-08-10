# Rate-limit and pagination semantics across Graph, Linear, Jira, and Slack

Research for #100 (child of #98), feeding the design ticket #101 that proposes a single
`remoteTransport` module owning the cursor loop, retry policy and clamp, item cap, and the
`http` and `pagination` debug events.

Every claim below is cited to primary vendor documentation (learn.microsoft.com,
linear.app/developers, developer.atlassian.com, docs.slack.dev) or to the installed
`@linear/sdk` bundle. Where the vendor is silent or self-contradictory, that is stated rather
than smoothed over. Facts were gathered 2026-08-10.

## Verdict

One cursor loop: no, not as a single loop. One retry policy: yes, with a per-source predicate.

A shared `remoteTransport` can own the retry schedule, the clamp, the item cap, the page cap,
the `http` and `pagination` debug events, and the status-only error scrub. It cannot own the
decision of what counts as rate limiting, because Linear signals it at HTTP 400 with a GraphQL
error code and Slack can signal it in a JSON body, nor the shape of "what is the next page",
because the four contracts differ in kind: an opaque absolute URL (Graph), a cursor plus a
boolean (Linear, Slack), and a token plus a boolean (Jira). The workable seam is a transport
that takes two source-supplied functions — `isRateLimited(response) → retryAfterMs | null` and
`nextPage(body) → cursorState | null` — and owns everything around them.

Details, and the four contradictions between the code today and the documented contracts, follow.

## 1. How each API signals throttling

### Microsoft Graph

Status code 429. "When a throttling threshold is exceeded, Microsoft Graph: Limits any further
requests from that client app for some time. Returns HTTP status code 429 Too Many Requests and
the requests fail. Returns a suggested wait time in the response header of the failed request."
(https://learn.microsoft.com/en-us/graph/throttling)

503 is documented separately as service overload, not throttling, but with the same handling:
"This is likely because the services are busy. You should employ a back-off strategy similar to
429. Additionally, you should always make new retry requests over a new HTTP connection."
(https://learn.microsoft.com/en-us/graph/best-practices-concept). 509 Bandwidth Limit Exceeded
exists as a distinct throttling code
(https://learn.microsoft.com/en-us/graph/errors).

Header: `Retry-After` only. "All the resources and APIs described in the Service-specific limits
provide a `Retry-After` header except where indicated." The sample response is `Retry-After: 10`.
Graph documents no `RateLimit-*` and no `x-ms-*` throttling headers, so there is no preemptive
signal to build against.

Units: the Graph docs never state the unit. The instruction is "Wait the number of seconds
specified in the `Retry-After` header", and the sample is a bare integer, but no page says Graph
never emits an HTTP-date. Ambiguous. RFC 9110 permits both forms, so a client should parse both.

Upper bound: not documented anywhere on learn.microsoft.com. No maximum, no typical range, no
cap. Any client-side ceiling is the client's own policy.

Backoff schedule: `Retry-After` is primary; exponential backoff is documented only as the
fallback when the header is absent. "If no `Retry-After` header is provided by the response, we
recommend implementing an exponential backoff retry policy." No jitter, no multiplier, no
ceiling, and no maximum retry count is documented — the literal instruction is "Continue to use
the recommended `Retry-After` delay and retry the request until it succeeds."

Rule against retrying: "Avoid immediate retries, because all requests accrue against your usage
limits." Retrying is not forbidden; retrying without honoring the delay is discouraged because
throttled requests still count.

Outlook-specific limits (calendar and mail), from
https://learn.microsoft.com/en-us/graph/throttling-limits: "The Outlook service applies limits to
each app ID and mailbox combination." 10,000 API requests per 10 minutes, four concurrent
requests, 150 MB upload per 5 minutes. There is no cost or resource-unit model for Outlook; the
limits are raw request counts. A global per-app limit of 130,000 requests per 10 seconds applies
on top, and "The first limit to be reached triggers throttling behavior."

### Linear

Not 429. "With GraphQL requests, response http status code will be 400, but you can catch these
by inspecting the `errors` in the response body containing the `RATELIMITED` error code."
(https://linear.app/developers/rate-limiting). The string 429 does not appear in that page's
prose.

Headers: three families, all documented on the same page. Request count
(`X-RateLimit-Requests-Limit`, `-Remaining`, `-Reset`), endpoint-specific
(`X-RateLimit-Endpoint-Requests-Limit`, `-Remaining`, `-Reset`, `X-RateLimit-Endpoint-Name`), and
complexity (`X-Complexity`, `X-RateLimit-Complexity-Limit`, `-Remaining`, `-Reset`).

The `-Reset` headers are "The time at which the current rate limit window resets in UTC epoch
milliseconds" — an absolute timestamp in milliseconds, not a delta and not seconds. `Retry-After`
is not documented at all and should not be depended on.

Linear limits by both request count and query complexity, independently. API key: 2,500 requests
per user per hour in the table, but the prose on the same page says "5,000 requests per hour" —
the page contradicts itself. Size against the lower figure. OAuth app: 5,000 per user per hour.
Unauthenticated: 600 per IP per hour. Complexity: 3,000,000 points/hour (API key), 2,000,000
(OAuth), 100,000 (unauthenticated), plus "a maximum complexity of a single query at any time to
10,000 points. Your query will always get rejected if it exceeds that."

Backoff schedule: none documented. The only mechanism statement is "We use the leaky bucket
algorithm for our rate limiters, which means that your tokens are refilled with a constant rate
of `LIMIT_AMOUNT / LIMIT_PERIOD`", which implies partial recovery before the reset timestamp. No
upper bound documented, no rule against retrying.

Normal GraphQL errors arrive as HTTP 200 with an `errors` array: "GraphQL queries can partially
succeed with a 200 HTTP status, returning some data while including errors for failed fields."
Rate limiting is the exception, at HTTP 400, discriminated by `extensions.code === "RATELIMITED"`.

### Jira Cloud

Status code 429, for all three limiter types. "When any limit is exceeded, Jira returns an HTTP
429 Too Many Requests response." (https://developer.atlassian.com/cloud/jira/platform/rate-limiting/)
503 is explicitly not rate limiting but shares the shape: "Some transient 5xx responses (such as
503) may also include a `Retry-After` header. While these are not rate limit responses, you can
handle them with similar retry logic."

Three independent limiters, distinguished by the `RateLimit-Reason` header: a points-based hourly
quota (`jira-quota-global-based` / `jira-quota-tenant-based`), a per-second per-endpoint burst
bucket (`jira-burst-based`, GET default 100 rps), and per-issue writes
(`jira-per-issue-on-write`). Per-reason handling differs: burst means back off that endpoint
only, quota means "Pause all API requests until the window resets."

Headers on a 429: `Retry-After` ("Indicates how many seconds to wait before retrying"),
`X-RateLimit-Reset` ("ISO 8601 timestamp when the current window resets"), `RateLimit-Reason`,
plus `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-NearLimit` ("Returns `true`
when less than 20% of capacity remains") on ordinary responses. A `Beta-RateLimit-Policy` /
`Beta-RateLimit` structured pair is documented as informational during beta.

Units: seconds, integer. Atlassian's own pseudocode does `retryDelayMillis = 1000 *
headerValue('Retry-After')`. No HTTP-date form is documented.

Upper bound: not documented. The only cap in the docs is client-side, in Atlassian's own
pseudocode: `maxRetryDelayMillis = 30000`, and that branch applies only when the header is
absent. Documented example values include `Retry-After: 1847` (about 31 minutes), so a
30-second clamp will silently under-wait a quota 429.

Backoff schedule: recommended, not required, and every element is hedged with "e.g.":
"Use exponential backoff with jitter", "Begin with a reasonable initial delay (e.g., 2 seconds)",
"double the delay up to some maximum (e.g., retry after 2, 4, 8, 16 seconds and so on)",
"Multiply the delay by a random factor (e.g; between 0.7 and 1.3)", "Cap the number of retries
(e.g., 4 attempts)".

Two internal contradictions on that page worth recording. First, one best practice says "Only
retry if the API is idempotent and the response includes a `Retry-After` header" — read
literally, a 429 with no header should not be retried at all — while the published pseudocode
has an explicit branch that retries such a 429 with `min(2 * lastRetryDelayMillis, 30000)`.
Second, the pseudocode applies jitter as `retryDelayMillis += retryDelayMillis *
randomInRange([0.7, 1.3])`, which increases the delay by 70–130% rather than multiplying by
0.7–1.3 as the prose says.

Cost model: points, per app, hourly, reset at the top of each UTC hour. "Each request starts with
a base cost of 1 point, and additional points are added for each object involved." Issues cost 1
point each, identity objects 2. Tier 1 default is a 65,000-point hourly pool shared across all
tenants. A 100-issue `search/jql` page therefore costs about 101 points. The FAQ is blunt about
the failure mode: "All requests are denied until the next hourly reset. There is no gradual
throttling."

### Slack

Status code 429. "If you exceed a rate limit when using any of our HTTP-based APIs (including
incoming webhooks), Slack will return a `HTTP 429 Too Many Requests` error, and a `Retry-After`
HTTP header containing the number of seconds until you can retry."
(https://docs.slack.dev/apis/web-api/rate-limits)

Units: seconds, integer, never an HTTP-date. Upper bound: not documented.

Tiers are per method, per workspace, per app, with per-minute windows: Tier 1 "1+ per minute",
Tier 2 "20+", Tier 3 "50+", Tier 4 "100+", plus a Special tier where "Rate limiting conditions
are unique for methods with this tier." The methods rundown uses: `search.messages` Tier 2,
`conversations.replies` Tier 3, `users.info` Tier 4, `oauth.v2.access` special at 600 per minute.

Pagination changes the tier: "For methods supporting cursored pagination, the rate limit given
applies when you're using pagination. If you're not, you'll receive stricter rate limits."

The May 2025 change matters for the `threads` option: "As of May 29, 2025, for new applications
and installation commercially distributed outside of the Marketplace, this method is rate limited
to 1 request per minute. The maximum and default values for the `limit` parameter have both been
reduced to 15 objects." (https://docs.slack.dev/reference/methods/conversations.replies).
Internal customer-built apps keep Tier 3. rundown's Slack app is an admin-registered
single-workspace app (ADR-0014 §6), so it is internal customer-built and unaffected — but that
depends on how it is installed, and the exception is worth stating in the design.

Ambiguity: search-engine caches of those method pages carry a sentence extending the new limits
to existing non-Marketplace installations from 3 March 2026. That sentence is not present on the
live pages today, which still say such installations "will not be subject" to them. Unverified
either way.

Backoff schedule: none documented. The only instruction is to honor the header: "By evaluating
the `Retry-After` header you can wait for the indicated number of seconds before retrying the
same request or continuing to use that method for this workspace." The only design hint is
"we do recommend you design your apps with a limit of 1 request per second for any given API
call". The only prohibition-shaped statement concerns RTM message sending: "Continuing to send
messages after exceeding a rate limit runs the risk of your app being permanently disabled."

Body-level signalling: every method's error table lists `ratelimited` — "The request has been
ratelimited. Refer to the `Retry-After` header for when to retry the request." No Slack page maps
`ok: false` error codes to HTTP status codes, so whether a `ratelimited` body can arrive with a
non-429 status is undocumented. The safe client rule is to treat `status === 429` or
`ok === false && error === "ratelimited"` as rate-limited, reading `Retry-After` in both cases.

Token refresh has its own constraints (https://docs.slack.dev/authentication/using-token-rotation):
"Refresh tokens are designed to be used once. After calling `oauth.v2.access`, the refresh token
you used is revoked after a short grace period", and repeated refreshes within 12 hours hit "a
limit of 2 active tokens", with the oldest revoked. Blind retry of a refresh is unsafe in a way
that a data-read retry is not.

## 2. The pagination contract for each

### Graph — opaque absolute URL

Terminal page: the absence of `@odata.nextLink`. "To read all results, you must continue to call
Microsoft Graph with the `@odata.nextLink` property returned in each response until the
`@odata.nextLink` property is no longer returned."
(https://learn.microsoft.com/en-us/graph/paging). "The final page will not contain an
`@odata.nextLink` property."

The link is an opaque absolute URL and must be replayed whole: "You should include the entire URL
in the `@odata.nextLink` property in your request for the next page of results, treating the
entire URL as an opaque string", and "Don't try to extract the `$skiptoken` or `$skip` value and
use it in a different request." For mail specifically: "This API uses the `$skip` value to keep
count of all the items it has gone through in the user's mailbox… It's therefore possible that
even in the initial response, the `$skip` value is larger than the page size."
(https://learn.microsoft.com/en-us/graph/api/user-list-messages)

Expiry: not documented for non-delta paging. Delta tokens have documented lifetimes; `nextLink`
does not.

Page size: client-controlled via `$top`. "The minimum value of $top is 1 and the maximum depends
on the corresponding API." For messages: "The default page size is 10 messages. Use `$top` to
customize the page size, within the range of 1 and 1000." For `calendarView`: "CalendarView with
`$top` has a minimum value of 1 and maximum of 1000." Oversized values are unpredictable rather
than an error: "The requested page size might be ignored, it might default to the maximum page
size for that API, or Microsoft Graph might return an error."

Retry safety: not stated as a general guarantee. The one documented hazard is link selection
across a retry, and it is scoped to directory resources: "don't use tokens from retry operations
for subsequent page requests as these tokens aren't guaranteed to be valid for future requests.
Instead, persist the token from the last successful response and use it for the next page
request." Nothing equivalent is documented for Outlook mail or calendar. Delta explicitly
sanctions retrying the same link ("Retry the `@odata.nextLink` or `@odata.deltaLink` after some
time") and explicitly warns about replays: "Your application must be prepared for replays."

### Linear — Relay cursor plus boolean

Terminal page: `pageInfo.hasNextPage === false`. "pass the value of `pageInfo.endCursor` as
`after` parameter for the next request. You can do this as long as `pageInfo.hasNextPage` return
true" (https://linear.app/developers/pagination). There is no null-cursor sentinel in the
contract.

Default page size: 50. "The first 50 results are returned by default without query arguments."

Maximum page size: not documented. Neither 250 nor 100 appears on the pagination page. The real
ceiling is the 10,000-point single-query complexity cap, which scales with page size and field
selection rather than being a fixed row count. Any specific maximum in the codebase is folklore
unless it comes from the schema.

Cursor expiry: not documented either way.

### Jira Cloud — token plus boolean, and the two disagree

Terminal page: two documented signals that do not agree. The response schema for
`SearchAndReconcileResults` says of `nextPageToken`: "Continuation token to fetch the next page.
If this result represents the last or the only page this token will be null. This token will
expire in 7 days." The GET parameter documentation on the same endpoint says "The
`nextPageToken` field is not included in the response for the last page, indicating there is no
next page." `isLast` is documented as "Indicates whether this is the last page of the paginated
response." The 200 example carries `"isLast": true` and no `nextPageToken` at all.
(Atlassian's OpenAPI spec, https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json,
the machine-readable source behind
https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)

The robust rule: stop when `nextPageToken` is missing or null, and treat `isLast === true` as
corroboration. Do not drive the loop off `isLast` alone; it is not documented as always present.

Cursor expiry: 7 days, the only explicit token lifetime among the four APIs. Reuse is not
addressed — Atlassian never says whether a token is single-use or whether replaying it is safe.

Page size: client-controlled via `maxResults`, default 50, no `maximum` in the schema but a prose
ceiling: "It returns max 5000 issues." The same description warns that short pages are normal:
"To manage page size, API may return fewer items per page where a large number of fields or
properties are requested." A page smaller than `maxResults` is not a terminal-page signal.

The old offset endpoint `/rest/api/3/search` is marked `"deprecated": true` in the spec, summary
"Currently being removed". Offset pagination is not deprecated generally, only for issue search.

Result stability: undocumented. Atlassian documents staleness — "The API doesn't provide
read-after-write consistency by default"
(https://developer.atlassian.com/cloud/jira/platform/search-and-reconcile/) — but never says
whether a token pins a snapshot, or whether issues can be skipped or duplicated across a page
walk when data changes mid-walk. Dedupe by id regardless.

429 is not listed in the OpenAPI responses for the search endpoints. The rate-limiting page is
the authority there, not the per-endpoint spec.

### Slack — cursor, with three terminal forms and one non-cursor method

Terminal page: three equivalent forms, and a client must handle all of them. "An empty, null, or
non-existent `next_cursor` in the response indicates no further results", and separately "You'll
know that there are no further results to retrieve when a `next_cursor` field contains an empty
string (`""`). You're not even paginating at all if you receive no `response_metadata` or its
`next_cursor` value." (https://docs.slack.dev/apis/web-api/pagination)

Short pages are not terminal: "It's possible to receive fewer results than your specified
`limit`, even when there are additional results to retrieve. Avoid the temptation to check the
size of results against the limit to conclude the results have been completely returned."

Cursor expiry: documented qualitatively, with no TTL. "Cursors expire and are meant to be used
within a reasonable amount of time. You should have no trouble pausing between rate limiting
windows, but do not persist cursors for hours or days." Reuse is not addressed. The only
pagination error is `invalid_cursor`, "Returned when navigating a paginated collection and
providing a `cursor` value that just does not compute — either it's gibberish, somehow encoded
wrong, or of too great a vintage."

Page size: client-controlled via `limit`, with per-method maxima. "The `limit` parameter maximum
is `1000` and subject to change and may vary per method", and "Provide sensible `limit` values.
We recommend `100`-`200` results at a time." `conversations.replies` documents "Maximum of 999"
(reduced to 15 for affected non-Marketplace apps); `search.messages` uses `count` with "Maximum
of `100`". Invalid values "are currently magically adjusted to something sensible" rather than
rejected. The current docs do not use the word "suggestion"; the operative wording is that
`limit` sets "a _maximum_ number of results to return per call" and fewer may come back.

`search.messages` is listed under traditional `page`/`count` paging rather than cursor
pagination, but its own reference page also documents a `cursor` argument: "Use this when getting
results with cursormark pagination. For first call send `*` for subsequent calls, send the value
of `next_cursor` returned in the previous call's results." Its response carries both `pagination`
and `paging` objects. Cursormark is the right choice for deep result sets, since `page` is capped
at 100 and `count` at 100.

`conversations.replies` returns `has_more` alongside `response_metadata.next_cursor`.

## 3. Linear specifically: what the SDK handles

Installed version: `@linear/sdk` 88.1.0, at
`/Users/oyvindfanebust/src/privat/rundown/node_modules/@linear/sdk`. Line numbers below are into
the bundled `dist/index.mjs`.

`rawRequest` is defined at `dist/index.mjs:1348` inside `class LinearGraphQLClient`. It does not
use graphql-request — the bundle's own comment reads "Originally forked from graphql-request to
remove the external dependency". It is a single `globalThis.fetch` POST: build the body, one
fetch, parse, return or throw.

The SDK ships no retry and no backoff of any kind. `grep -c setTimeout dist/index.mjs` returns 0
across the whole 112k-line bundle: no sleep, no delay, no retry loop. The only non-generated
matches for retry or 429 are `dist/index.mjs:165` and `:174`, which read the `retry-after` header
into an error property, and `dist/index.mjs:274`, a single `status === 429` branch in the
error-type map. Retry is entirely the caller's job.

`rawRequest` returns `LinearRawResponse<Data>` — `{ data?, extensions?, headers?, status?,
error?, errors? }` (`dist/index.d.mts:25`, signature at `:121`). The `headers` and `status`
fields on the success path are the only place in the SDK where the live `X-RateLimit-*` and
`X-Complexity` values are handed to the caller; the typed `LinearClient` model path discards
them.

Pagination helpers exist but are unreachable from `rawRequest`. `class Request` has a
`paginate(fn, args)` helper (`:68550`) that loops `while (connection.pageInfo.hasNextPage)`, and
`class Connection` has `fetchNext()` (`:68633`) and `fetchPrevious()` (`:68642`). Those are
instance methods on model classes the generated `LinearSdk` constructs. `rawRequest` returns a
plain object with no class wrapper and no `_fetch` closure, so the `hasNextPage`/`endCursor` loop
is the caller's to write — which is what `src/sources/linear/index.ts:239-250` does.
`defaultConnection` (`:68569`) confirms the documented default with the comment "Defaults to 50
as per the Linear API".

Errors: `rawRequest` throws typed errors, `throw parseLinearError(new GraphQLClientError(...))`
at `dist/index.mjs:1371`. Fourteen subclasses of `LinearError` exist, including
`RatelimitedLinearError` (`:161`), the only one that reads headers — `retry-after`,
`x-ratelimit-requests-limit/-remaining/-reset`, `x-ratelimit-complexity-limit/-remaining/-reset`.
Its `requestsResetAt` JSDoc says "Unix timestamp at which the requests will be reset" without a
unit; per Linear's docs the value is milliseconds, so reading it as seconds yields a 1970 date.

There is a likely SDK bug worth verifying before any design depends on
`instanceof RatelimitedLinearError`. The mapping at `dist/index.mjs:274` is:

```js
errorConstructorMap[errors[0]?.type ?? (
  status === 403 ? Forbidden :
  status === 429 ? Ratelimited :
  `${status}`.startsWith("4") ? AuthenticationError :
  status === 500 ? InternalError :
  `${status}`.startsWith("5") ? NetworkError : Unknown)]
```

`errors[0].type` is read from `error?.extensions?.type` and matched against a map whose
rate-limit key is the lowercase string `"ratelimited"`. Linear's docs say the discriminator is
`extensions.code === "RATELIMITED"` at HTTP 400. HTTP 400 falls past the 403 and 429 branches
into `startsWith("4")`, producing `AuthenticationLinearError`. Unless Linear also emits an
undocumented `extensions.type` alongside the documented `extensions.code`, a real rate-limit
response deserializes as an authentication error and `RatelimitedLinearError` never fires. The
docs elide the rest of `extensions` with `...`, so this cannot be settled from documentation —
it needs one live 400 to confirm. The robust guard is to check `extensions.code === "RATELIMITED"`
directly rather than relying on the SDK's class.

One useful extra: the schema exposes a `rateLimitStatus` query returning `RateLimitResultPayload`
(`dist/index.d.mts:11804`), whose `reset` field is documented in the SDK types as "The UNIX
timestamp (in milliseconds) at which the rate limit will be fully replenished". That confirms the
millisecond unit independently of the docs page, and offers a way to check quota without running
a real query. It is not mentioned on Linear's rate-limiting page.

## 4. Where the code today contradicts the documented contract

Six findings, ordered by how much they matter.

Linear retries nothing, and could not detect a rate limit if it did.
`src/sources/linear/index.ts:66-82` wraps `rawRequest` in a try/catch that scrubs and rethrows.
The SDK adds no retry. Linear is the source with the most requests per run — relationships ×
{standing, recent} × pages, three nested loops at `:226-235` and `:242-248` — and it is the one
source that gives up on the first rate limit. Worse, a design that added a `status === 429` retry
here would never fire, because Linear returns 400. The correct predicate is
`extensions.code === "RATELIMITED"` in the GraphQL error array, subject to the SDK-mapping
question above.

`PAGE_SIZE = 50; // Linear default; max 250` at `src/sources/linear/index.ts:27` cites a
maximum that is not documented. Linear documents the default of 50 and documents no maximum at
all. The real ceiling is the 10,000-point single-query complexity cap, which depends on the
field selection in `ISSUES_QUERY` (`:87-108`), and that query inlines seven relations. The
comment should say so rather than assert a number.

Jira's `MAX_RETRY_MS = 30_000` clamp will under-wait a quota 429.
`src/sources/jira/index.ts:106,118-123` clamps `Retry-After` to 30 seconds. Atlassian's own
documented example of a quota-based 429 is `Retry-After: 1847`, and a quota window resets at the
top of the UTC hour, so the honest wait can approach an hour. The 30-second figure comes from
Atlassian's pseudocode, where it caps only the header-absent branch, not the header-present one.
The clamp is right as a defence against a hostile or absurd header; it is wrong as a cap on a
value Atlassian documents as legitimately large. A design should separate the two: a sanity
ceiling far above 30 seconds, plus a policy decision to give up rather than sleep for 30 minutes
inside a planning-tool run.

Jira retries once; Atlassian recommends four attempts with exponential backoff and jitter, and
distinguishes reasons. `src/sources/jira/index.ts:228-235` does one retry with no backoff
growth and no jitter. Atlassian also documents `RateLimit-Reason`, which distinguishes a burst
429 (retry that endpoint shortly) from a quota 429 ("Pause all API requests until the window
resets"). Reading that header would let the transport tell a one-second problem from an
hour-long one.

Slack's retry is unclamped. `src/sources/slack/auth.ts:179-183` reads
`Number(r.headers.get("retry-after")) || 1` and sleeps that many seconds, up to three times, with
no ceiling. Slack documents no upper bound on the header, so a backend value of 86,400 stalls the
run for a day. This is the same hazard `retryAfterMs` was written to prevent on the Jira side.
`|| 1` also silently converts a `Retry-After: 0` to one second, which is harmless, and converts
an HTTP-date to 1, which Slack never sends.

Slack does not treat a body-level `ratelimited` as rate limiting.
`src/sources/slack/auth.ts:187-188` returns the parsed body for any 2xx, and callers such as
`searchAll` (`src/sources/slack/index.ts:378`) turn `ok: false` into a hard failure through
`statusOnlyError`. If Slack ever answers 200 with `error: "ratelimited"`, that path aborts the
run instead of retrying. The docs do not say whether that happens, so this is a hardening
question, not a confirmed bug.

Two smaller observations. Graph paginates unbounded at `src/sources/graph/index.ts:114-130` with
no page cap and no item cap, and Graph is the source whose docs explicitly warn that a large page
"may trigger the gateway timeout (HTTP 504)". And the `pagination` debug event
(`src/debug.ts:46`) is emitted by exactly one source — Jira, at `src/sources/jira/index.ts:455`.
Graph, Linear, and Slack page silently. Unifying that event is a clear win independent of the
rest of the design.

## 5. What a shared transport can and cannot own

Shared, safely:

- The retry loop itself: attempt, classify, wait, re-attempt, give up, with an attempt count.
- The wait computation and the clamp, given a milliseconds value from the source's classifier.
  Parsing `Retry-After` as delta-seconds with an HTTP-date fallback covers Graph, Jira, and Slack;
  Linear supplies its own number from an absolute millisecond timestamp.
- The item cap and a page cap. All four docs decline to bound a page walk, and three of the four
  loops in the code today are unbounded.
- The `http` and `pagination` debug events, and the host/path-shape redaction rule the existing
  `http` emitters already follow.
- The status-only error scrub, which `sources/errors.ts` already centralizes.
- Dedupe-by-id across pages, which every source's docs make advisable and which Graph's delta
  guidance ("be prepared for replays") makes mandatory in the general case.

Per-source, necessarily:

- **Rate-limit classification.** 429 for Graph, Jira, and Slack; HTTP 400 plus
  `extensions.code === "RATELIMITED"` for Linear; possibly a 200 body for Slack. A single
  `status === 429` test is wrong for two of the four.
- **The wait source.** A `Retry-After` delta for Graph, Jira, and Slack; a UTC epoch-millisecond
  timestamp in `X-RateLimit-Requests-Reset` or `-Complexity-Reset` for Linear, which has no
  `Retry-After`.
- **The retry budget and ceiling.** A Jira quota 429 can legitimately ask for half an hour; a
  Slack Tier 2 429 asks for seconds. One number cannot serve both.
- **The page-state shape.** An absolute opaque URL that replaces the whole request (Graph), a
  cursor argument inside a GraphQL variable set (Linear), a token in a POST body (Jira), a
  cursor in a form-encoded parameter (Slack). The loop is the same shape; the state is not the
  same type.
- **The terminal-page test.** Absence of a key (Graph), a boolean (Linear), a token that may be
  absent or null with a corroborating boolean (Jira), a cursor that may be empty, null, or absent
  (Slack).
- **Page size and its maximum.** 1,000 for Graph messages and `calendarView`, undocumented for
  Linear (bounded by query complexity), 5,000 for Jira `search/jql`, 100–999 per method for Slack.
- **Auth and routing.** Bearer plus `Prefer: outlook.timezone="UTC"` for Graph, SDK-managed for
  Linear, Basic auth with the gateway-then-instance fallback for Jira
  (`src/sources/jira/index.ts:238-255`), bearer plus form-encoding for Slack. None of this is
  transport-shaped in the shared sense.
- **Refresh-retry safety.** Slack's refresh token is single-use with a short grace period and a
  two-active-token limit, so the auth path must not inherit the data path's retry policy.

## 6. Which facts are firm, and which are not

Firm:

- Graph, Jira, and Slack all use 429 with `Retry-After` in seconds. Linear uses 400 with a
  GraphQL error code and no `Retry-After`.
- Linear's reset headers are UTC epoch milliseconds.
- Jira page tokens expire after 7 days. No other API documents a cursor lifetime numerically.
- Slack cursors expire, with no stated TTL, and "do not persist cursors for hours or days".
- Graph's `nextLink` is an opaque absolute URL that must be replayed unmodified.
- Page size is client-controlled on all four.
- The Linear SDK ships zero retry and zero backoff, and `rawRequest` gives no pagination helper.
- No vendor documents an upper bound on its retry-after value.
- No vendor forbids retrying a cursor or page request.

Not firm, and the design should treat these as open:

- Whether Graph ever sends `Retry-After` as an HTTP-date. Unstated; parse both.
- Whether a Graph `nextLink` expires, and whether replaying an Outlook `nextLink` returns the
  same page. Documented only for directory resources.
- Linear's API-key request limit: the same page says both 2,500 and 5,000 per hour.
- Linear's maximum page size: no number is documented anywhere.
- Whether Linear cursors expire: no statement either way.
- Whether the Linear SDK's `RatelimitedLinearError` ever fires against the live API, given the
  `extensions.type` versus `extensions.code` mismatch. Needs one live 400.
- Jira's terminal-page signal: the schema says null token, the parameter doc says absent token,
  and `isLast` is a third signal. Handle all three.
- Whether a Jira page token may be replayed, and whether a page walk sees a stable snapshot.
- Whether Slack ever signals rate limiting with HTTP 200 and `error: "ratelimited"`.
- Whether the March 2026 extension of Slack's non-Marketplace limits to existing installations is
  real; it appears in cached copies of the method pages but not on the live pages.
