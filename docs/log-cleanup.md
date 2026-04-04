# Log Cleanup

## Goal

Reduce Dashboard log volume from ~5 million lines per 2 hours to near zero. The Dashboard MiniApp is being moved into the cloud (already on dev, pending merge to main), so this is a temporary fix to stop the log flooding until the merge happens.

## What to change

Remove almost all logging from `src/index.ts`. This app does not need runtime logs in production. The only logs worth keeping are:

- `logger.error` calls (keep all error logging)
- Session start: one log when `onSession` is called
- Session stop: one log when `onStop` is called

Everything else should be deleted, not downgraded to debug. There is no reason to keep debug-level logs in an app that is about to be replaced. Fewer lines to ship, fewer lines to parse, fewer lines to pay for.

This includes removing:

- All info logs inside `updateDashboardSections` and its sub-functions (`formatTimeSection`, `formatBatterySection`, `formatNotificationSection`, `formatStatusSection`, `formatCalendarEvent`)
- All info logs inside event handlers (`handlePhoneNotification`, `handlePhoneNotificationDismissed`, `handleBatteryUpdate`, `handleLocationUpdate`, `handleCalendarEvent`)
- All info logs inside `setupEventHandlers`, `setupSettingsHandlers`, `initializeDashboard`
- The 60-second interval log that fires once per minute per session
- All debug logs
- All emoji-prefixed log messages
- The `logger.info({ sessionInfo, location: ... })` call that dumps the entire session object

## What NOT to change

- Do not refactor the app logic. Just delete log lines.
- Do not touch the dashboard functionality.
- This app is being replaced. Keep changes minimal.