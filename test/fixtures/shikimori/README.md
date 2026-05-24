# Shikimori API fixtures

Captured responses from `shikimori.one` for fixture-replay tests in
`test/api-clients/shikimori.test.ts`. The replay tests mock `global.fetch` to
return these payloads and assert our parsers (in `src/main/shikimori.ts`)
produce the expected typed objects.

## What's covered

| Fixture | Endpoint | Used by |
|---|---|---|
| `whoami.json` | `GET /api/users/whoami` | `getUser` |
| `user-rates-found.json` | `GET /api/v2/user_rates?user_id=…&target_id=…&target_type=Anime` | `getUserRate` (hit) |
| `user-rates-empty.json` | same as above | `getUserRate` (miss → returns null) |
| `user-rate-created.json` | `POST /api/v2/user_rates` | `createUserRate` |
| `user-rate-updated.json` | `PATCH /api/v2/user_rates/{id}` | `updateUserRate` |
| `user-anime-rates.json` | `GET /api/users/{id}/anime_rates` | `getUserAnimeRates` |
| `anime-details.json` | `GET /api/animes/{id}` | `getAnimeDetails` |
| `friends.json` | `GET /api/users/{id}/friends` | `getFriends`, `getFriendsRatesForAnime` |
| `friend-history.json` | `GET /api/users/{id}/history?target_type=Anime` | `getFriendHistory` (private), `getFriendsActivity` |
| `calendar.json` | `GET /api/calendar` | `getCalendar` |
| `franchise.json` | `GET /api/animes/{id}/franchise` | `getFranchise` |
| `token-refresh.json` | `POST /oauth/token` | `refreshToken` (private), `ensureFreshToken` |

## Anonymization

All fixtures use synthetic user IDs (`1`, `2`, …) and never carry a real
`access_token` / `refresh_token` / `Bearer` value. The fake credentials in
`token-refresh.json` are clearly named (`fake-access-token-replaced`).

## Refreshing fixtures

If a parser starts failing in production after an upstream schema change,
re-record the relevant fixture by hand from the API docs at
<https://shikimori.one/api/doc> or by capturing one real response with `curl`,
**then anonymize** as above before committing.

A separate (proposed) issue #141 wires a nightly cron that calls the real API
and pages when schema drift makes a fixture stale.
