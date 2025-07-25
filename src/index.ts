/**
 * Dashboard Manager TPA 
 * 
 * System TPA that provides the dashboard functionality for AugmentOS
 * using the SDK Dashboard API.
 */
import path from "path";
import {
  TpaServer,
  TpaSession,
  StreamType,
  DashboardMode,
  GlassesBatteryUpdate,
  LocationUpdate,
  PhoneNotification,
  CalendarEvent
} from '@augmentos/sdk';
import { wrapText } from './text-utils';
import tzlookup from 'tz-lookup';
import { v4 as uuidv4 } from 'uuid';
import { WeatherModule } from './dashboard-modules/WeatherModule';
import { NotificationSummaryAgent } from './agents';
import { logger } from '@augmentos/sdk';

// Configuration constants
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 80;
const PACKAGE_NAME = "system.augmentos.dashboard";
const API_KEY = process.env.AUGMENTOS_API_KEY || '';

// Validate API key
if (!API_KEY) {
  logger.error({ tpa: PACKAGE_NAME, packageName: PACKAGE_NAME }, "AUGMENTOS_API_KEY environment variable is required.");
  process.exit(1);
}

// List of notification app names to ignore
const notificationAppBlackList = ['youtube', 'augment', 'maps'];

/**
 * Dashboard Manager TPA - Main application class
 * 
 * This is the system dashboard TPA that manages system information
 * display and dashboard mode control. It uses the AugmentOS SDK's
 * dashboard.system API to update dashboard sections and control modes.
 */
class DashboardServer extends TpaServer {
  // Keep track of active sessions with their metadata
  private _activeSessions: Map<string, {
    userId: string;
    batteryLevel?: number;
    latestLocation?: { latitude: number; longitude: number; timezone?: string };
    phoneNotificationCache: { title: string; content: string; timestamp: number; uuid: string }[];
    phoneNotificationRanking?: { summary: string; timestamp: number }[];
    calendarEvent?: any;
    weatherCache?: { timestamp: number; data: string };
    dashboardMode: DashboardMode;
    updateInterval?: NodeJS.Timeout;
    userDatetime?: string;
  }> = new Map();

  private notificationSummaryAgent: NotificationSummaryAgent;

  constructor() {
    super({
      packageName: PACKAGE_NAME,
      port: PORT,
      apiKey: API_KEY,
      publicDir: path.join(__dirname, "./public"),
    });

    this.notificationSummaryAgent = new NotificationSummaryAgent();

    this.logger.info('Dashboard Manager initialized with configuration', {
      packageName: PACKAGE_NAME,
      port: PORT
    });
  }

  /**
   * Called by TpaServer when a new session is created
   */
  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    const logger = session.logger; // Use session logger to have session-specific logs with userId correlation

    logger.info(`🚀 New dashboard session started for user ${userId}`, {
      sessionId,
      userId,
      timestamp: new Date().toISOString()
    });

    // Check if session already exists, if so clean it up.
    if (this._activeSessions.has(sessionId)) {
      logger.warn(`Session ${sessionId} already exists, cleaning up previous session data.`);
      const existingSession = this._activeSessions.get(sessionId);
      if (existingSession?.updateInterval) {
        clearInterval(existingSession.updateInterval);
        logger.info(`Cleared existing update interval for session ${sessionId}`);
      }
      this._activeSessions.delete(sessionId);
      logger.info(`Previous session data cleaned up for ${sessionId}`);
    }
    // Log session creation
    logger.info(`📊 Initializing dashboard session for user ${userId}`, {
      sessionId,
      timestamp: new Date().toISOString()
    });

    // Initialize session metadata
    this._activeSessions.set(sessionId, {
      userId,
      phoneNotificationCache: [],
      dashboardMode: DashboardMode.MAIN
    });

    logger.info(`📊 Dashboard session initialized with mode: ${DashboardMode.MAIN}`);

    // Listen for custom messages, including datetime updates
    session.events.on('custom_message', (message: any) => {
      logger.debug({ message }, `📊 Received custom message`);
      if (message.action === 'update_datetime') {
        logger.debug(`📊 Updating user datetime for session ${sessionId}`);
        const sessionInfo = this._activeSessions.get(sessionId);
        if (sessionInfo) {
          sessionInfo.userDatetime = message.payload.datetime;
          this.updateDashboardSections(session, sessionId);
        }
      }
    });

    // Set up event handlers for this session
    this.setupEventHandlers(session, sessionId);
    logger.info(`✅ Event handlers set up for session ${sessionId}`);

    // Initialize dashboard content and state
    this.initializeDashboard(session, sessionId);
    logger.info(`✅ Dashboard initialized for session ${sessionId}`);

    // Set up settings handlers
    this.setupSettingsHandlers(session, sessionId);
    logger.info(`✅ Settings handlers set up for session ${sessionId}`);

    // Start dashboard update interval
    const updateInterval = setInterval(() => {
      logger.info(`⏰ Scheduled dashboard update triggered for session ${sessionId}`);
      this.updateDashboardSections(session, sessionId);
    }, 60000); // Update every minute

    // Store the interval reference for cleanup
    const sessionInfo = this._activeSessions.get(sessionId);
    if (sessionInfo) {
      // if sessionInfo already has an interval, clear it first
      if (sessionInfo.updateInterval) {
        clearInterval(sessionInfo.updateInterval);
      }
      sessionInfo.updateInterval = updateInterval;
      logger.info(`✅ Dashboard update interval scheduled for session ${sessionId}`);
    }

    const useMetric = session.settings.getAugmentosSetting('metricSystemEnabled'); // Get from session settings
    logger.info(`[Dashboard] Metric system enabled: ${useMetric}`);
    logger.info(`✅ Dashboard session setup completed for user ${userId}`, {
      sessionId,
      activeSessionCount: this._activeSessions.size
    });
  }

  /**
   * Set up handlers for settings changes
   */
  private setupSettingsHandlers(session: TpaSession, sessionId: string): void {
    const logger = session.logger; // Use session logger to have session-specific logs with userId correlation

    // Listen for specific setting changes
    session.settings.onValueChange('dashboard_content', (newValue, oldValue) => {
      logger.info(`Dashboard content setting changed from ${oldValue} to ${newValue} for session ${sessionId}`);

      // Apply the setting change immediately
      this.updateDashboardSections(session, sessionId);
    });

    // Listen for AugmentOS metric system changes (using new event system)
    session.settings.onAugmentosSettingChange('metricSystemEnabled', (newValue, oldValue) => {
      logger.info(`AugmentOS metricSystemEnabled changed from ${oldValue} to ${newValue} for session ${sessionId}`);

      // Force refresh weather data with new unit setting
      const sessionInfo = this._activeSessions.get(sessionId);
      logger.info({ sessionInfo, location: sessionInfo?.latestLocation })
      if (sessionInfo && sessionInfo.latestLocation) {
        // Fetch fresh weather data with new units
        this.fetchWeatherData(session, sessionId,
          sessionInfo.latestLocation.latitude,
          sessionInfo.latestLocation.longitude,
          true); // force update regardless of cache
      }
    });

    // Get and log current settings
    const dashboardContent = session.settings.get('dashboard_content', 'none');
    logger.info(`Current dashboard content setting: ${dashboardContent} for session ${sessionId}`);
  }

  /**
   * Called by TpaServer when a session is stopped
   */
  protected async onStop(
    sessionId: string,
    userId: string,
    reason: string
  ): Promise<void> {
    this.logger.info({ userId }, `Dashboard session stopped: ${reason}`);

    // Clean up any intervals
    const sessionInfo = this._activeSessions.get(sessionId);
    if (sessionInfo?.updateInterval) {
      clearInterval(sessionInfo.updateInterval);
    }

    // Remove from active sessions map
    this._activeSessions.delete(sessionId);

    this.logger.info({ activeSessionCount: this._activeSessions.size }, `Dashboard session resources cleaned up`);
  }

  /**
   * Set up event handlers for a session
   */
  private setupEventHandlers(session: TpaSession, sessionId: string): void {
    const logger = session.logger; // Use session logger to have session-specific logs with userId correlation

    // Handle phone notifications
    session.onPhoneNotifications((data) => {
      this.handlePhoneNotification(session, sessionId, data);
    });

    // Handle location updates
    session.on(StreamType.LOCATION_UPDATE, (data: LocationUpdate) => {
      this.handleLocationUpdate(session, sessionId, data);
    });

    // Handle head position changes
    session.onHeadPosition((data) => {
      if (data.position === 'up') {
        this.updateDashboardSections(session, sessionId);
      }
    });

    // Handle battery updates
    session.on(StreamType.GLASSES_BATTERY_UPDATE, (data: GlassesBatteryUpdate) => {
      this.handleBatteryUpdate(session, sessionId, data);
    });

    // Handle calendar events
    session.on(StreamType.CALENDAR_EVENT, (data: CalendarEvent) => {
      this.handleCalendarEvent(session, sessionId, data);
    });

    // Handle dashboard mode changes (from cloud side)
    session.dashboard.content.onModeChange((mode) => {
      if (mode === 'none') return;

      const sessionInfo = this._activeSessions.get(sessionId);
      if (!sessionInfo) return;

      sessionInfo.dashboardMode = mode;
      logger.info(`Dashboard mode changed to ${mode} for session ${sessionId}`);
      this.updateDashboardSections(session, sessionId);
    });
  }

  /**
   * Initialize dashboard content and state
   */
  private initializeDashboard(session: TpaSession, sessionId: string): void {
    const logger = session.logger; // Use session logger to have session-specific logs with userId correlation

    const sessionInfo = this._activeSessions.get(sessionId);
    if (!sessionInfo) {
      logger.error(`❌ Failed to initialize dashboard: session info not found for ${sessionId}`);
      return;
    }

    logger.info(`🛠️ Initializing dashboard for session ${sessionId}`);

    // Set dashboard to main mode
    try {
      logger.info(`🔄 Setting dashboard mode to ${DashboardMode.MAIN} for session ${sessionId}`);
      session.dashboard.system?.setViewMode(DashboardMode.MAIN);
      sessionInfo.dashboardMode = DashboardMode.MAIN;
      logger.info(`✅ Dashboard mode set to ${DashboardMode.MAIN} for session ${sessionId}`);
    } catch (error) {
      logger.error(error, `❌ Error setting dashboard mode for session ${sessionId}`);
    }

    // Initialize dashboard sections
    try {
      logger.info(`🔄 Initializing dashboard sections for session ${sessionId}`);
      this.updateDashboardSections(session, sessionId);
      logger.info(`✅ Dashboard sections initialized for session ${sessionId}`);
    } catch (error) {
      logger.error(error, `❌ Error initializing dashboard sections for session ${sessionId}`);
    }
  }

  /**
   * Update all dashboard sections with current data
   */
  private updateDashboardSections(session: TpaSession, sessionId: string): void {
    const logger = session.logger; // Use session logger to have session-specific logs with userId correlation

    logger.info(`🔄 Updating dashboard sections for session ${sessionId}`);

    const sessionInfo = this._activeSessions.get(sessionId);
    if (!sessionInfo) {
      logger.error(`❌ Failed to update dashboard: session info not found for ${sessionId}`);
      return;
    }

    try {
      // Format time and battery together for top left (to match original format)
      const timeText = this.formatTimeSection(session, sessionInfo);
      const batteryText = this.formatBatterySection(sessionInfo);
      const statusText = this.formatStatusSection(session, sessionInfo);
      const notificationText = this.formatNotificationSection(sessionInfo);

      // Dashboard sections
      const topLeftText = `${timeText}, ${batteryText}`;
      const topRight = statusText;
      const bottomLeft = notificationText;

      session.dashboard.system?.setTopLeft(topLeftText);
      session.dashboard.system?.setTopRight(topRight);
      session.dashboard.system?.setBottomLeft(bottomLeft);

      // Don't send bottom right since we're not using it in the original format
      // session.dashboard.system?.setBottomRight("");
      logger.debug({ topLeftText, topRight, bottomLeft }, `Updated dashboard for ${session.userId}`)
    } catch (error) {
      logger.error(error, `❌ Error updating dashboard sections for user ${session.userId}`);
    }
  }

  /**
   * Format time section text
   */
  private formatTimeSection(session: TpaSession, sessionInfo: any): string {
    const logger = session.logger;
    logger.debug({ sessionInfo }, `319 Format time section: ${sessionInfo.userDatetime}`);
    // 1. Use userDatetime if present
    if (sessionInfo.userDatetime) {
      try {
        // Extract the time part from the ISO string, ignoring timezone
        // Example: "2025-05-15T19:12:26+08:00" -> "19:12"
        const match = sessionInfo.userDatetime.match(/T(\d{2}):(\d{2})/);
        if (match) {
          const monthDay = sessionInfo.userDatetime.slice(5, 10).replace("-", "/"); // "05-15" -> "05/15"
          let hour = parseInt(match[1], 10);
          const minute = match[2];
          const ampm = hour >= 12 ? 'PM' : 'AM';
          hour = hour % 12;
          if (hour === 0) hour = 12;
          // Add leading zero if hour < 10
          const hourStr = hour < 10 ? `0${hour}` : `${hour}`;
          const formatted = `${monthDay}, ${hourStr}:${minute}`;
          logger.info(`332 User datetime (12hr): ${formatted}`);
          return `◌ ${formatted}`;
        }
      } catch (e) {
        // fallback below
      }
    }
    // 2. Use current time in user's timezone if available
    if (sessionInfo.latestLocation?.timezone) {
      try {
        const timezone = sessionInfo.latestLocation.timezone;
        const options = {
          timeZone: timezone,
          hour: '2-digit' as const,
          minute: '2-digit' as const,
          month: 'numeric' as const,
          day: 'numeric' as const,
          hour12: true
        };
        let formatted = new Date().toLocaleString('en-US', options);
        formatted = formatted.replace(/ [AP]M/, "");
        return `◌ ${formatted}`;
      } catch (error) {
        logger.error(error, `Error formatting time doe session ${session.userId}`);
        // fallback below
      }
    }
    // 3. Fallback: show placeholder
    return "◌ $DATE$, $TIME12$";
  }

  /**
   * Format battery section text
   */
  private formatBatterySection(sessionInfo: any): string {
    return (typeof sessionInfo.batteryLevel === 'number')
      ? `${sessionInfo.batteryLevel}%`
      : "$GBATT$";
  }

  /**
   * Format notification section text
   */
  private formatNotificationSection(sessionInfo: any): string {
    // Use ranked notifications if available, otherwise use the raw cache
    const notifications = sessionInfo.phoneNotificationRanking ||
      sessionInfo.phoneNotificationCache || [];

    if (notifications.length === 0) return "";

    // Take the latest 2 notifications
    const topNotifications = notifications.slice(0, 2);

    // Format differently based on whether we're using ranked or raw notifications
    if (topNotifications.length > 0 && 'summary' in topNotifications[0]) {
      return topNotifications
        .map((notification: { summary: string; timestamp: number }) =>
          wrapText(notification.summary, 25))
        .join('\n');
    } else {
      return topNotifications
        .map((notification: { title: string; content: string; timestamp: number; uuid: string }) =>
          `${notification.title}: ${notification.content}`)
        .join('\n');
    }
  }

  /**
   * Format status section text
   */
  private formatStatusSection(session: TpaSession, sessionInfo: any): string {
    // Prioritize calendar events if available and not expired
    if (sessionInfo.calendarEvent) {
      const event = sessionInfo.calendarEvent;
      let now: Date;
      let start = new Date(event.dtStart);
      const end = event.dtEnd ? new Date(event.dtEnd) : null;
      const tenMinutes = 10 * 60 * 1000;

      // Always restrict: userDatetime > timezone > system time
      let isTomorrow = false;
      let startInTz = start;
      if (event.timeZone) {
        const tz = event.timeZone;
        now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
        startInTz = new Date(new Date(event.dtStart).toLocaleString('en-US', { timeZone: tz }));
      } else if (sessionInfo.userDatetime) {
        now = new Date(sessionInfo.userDatetime);
        startInTz = new Date(event.dtStart);
      } else if (sessionInfo.latestLocation?.timezone) {
        const tz = sessionInfo.latestLocation.timezone;
        now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
        startInTz = new Date(start.toLocaleString('en-US', { timeZone: tz }));
      } else {
        now = new Date();
        startInTz = start;
      }

      // Only show if event is today or tomorrow
      const isToday = now.getFullYear() === startInTz.getFullYear() &&
        now.getMonth() === startInTz.getMonth() &&
        now.getDate() === startInTz.getDate();
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      isTomorrow = tomorrow.getFullYear() === startInTz.getFullYear() &&
        tomorrow.getMonth() === startInTz.getMonth() &&
        tomorrow.getDate() === startInTz.getDate();

      if (!(isToday || isTomorrow)) {
        // Event is not today or tomorrow, do not show
        // Fall through to weather/default
      } else {
        // If event has an end time, hide if now > end
        if (end && now > end) {
          // Don't show expired event
        } else if (now > startInTz) {
          // Hide if now is past the event start time
        } else {
          return this.formatCalendarEvent(session, event, sessionInfo, isTomorrow);
        }
      }
      // Otherwise, fall through to weather/default
    }

    // Then weather if available
    if (sessionInfo.weatherCache) {
      return sessionInfo.weatherCache.data;
    }

    // Default status note: previously "Status: connected".
    return "";
  }

  /**
   * Format calendar event
   */
  private formatCalendarEvent(session: TpaSession, event: any, sessionInfo: any, isTomorrow: boolean = false): string {
    const logger = session.logger; // Use session logger to have session-specific logs with userId correlation.
    logger.debug({ event, sessionInfo }, `Formatting calendar event for session ${session.userId}`);

    try {
      // PRIORITIZE event.timeZone, then user location, then system time
      const timezone = event.timeZone || sessionInfo.latestLocation?.timezone;

      logger.debug({ timezone }, `Calendar event timezone: ${timezone}`);

      let eventDate: Date;
      if (timezone) {
        // Convert the event start time into a localized Date object
        const localized = new Date(new Date(event.dtStart).toLocaleString("en-US", { timeZone: timezone }));
        eventDate = localized;
      } else {
        eventDate = new Date(event.dtStart); // fallback
      }

      const formattedTime = eventDate.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      }).replace(" ", "");

      const title = event.title.length > 10
        ? event.title.substring(0, 7).trim() + '...'
        : event.title;

      const prefix = isTomorrow ? 'tmr @ ' : '';
      return `${prefix}${title} @ ${formattedTime}`;
    } catch (error) {
      logger.error(error, `Error formating calendar event for session ${session.userId}`);
      logger.error({ sessionInfo, event }, `Error formating calendar event for session ${session.userId}`);
      return "Calendar event";
    }
  }

  /**
   * Handle phone notification event
   */
  private async handlePhoneNotification(session: TpaSession, sessionId: string, data: PhoneNotification): Promise<void> {
    const logger = session.logger; // Use session logger to have session-specific logs with userId correlation
    logger.debug({ data, function: "handlePhoneNotification" }, `handlePhoneNotification for session ${sessionId}`);

    // Check if session exists
    const sessionInfo = this._activeSessions.get(sessionId);
    if (!sessionInfo) return;

    // Check if the app name is blacklisted
    if (data.app && notificationAppBlackList.some(app =>
      data.app.toLowerCase().includes(app))) {
      logger.debug(`Notification from ${data.app} is blacklisted.`);
      return;
    }

    // Add notification to cache
    const newNotification = {
      title: data.title || 'No Title',
      content: data.content || '',
      timestamp: Date.now(),
      uuid: uuidv4(),
      appName: data.app || '',
      text: data.content || ''
    };

    // Prevent duplicate notifications
    const cache = sessionInfo.phoneNotificationCache;
    if (cache.length > 0) {
      const lastNotification = cache[cache.length - 1];
      if (lastNotification.title === newNotification.title &&
        lastNotification.content === newNotification.content) {
        logger.debug(`Duplicate notification detected. Not adding to cache.`);
        return;
      }
    }

    // Add to cache
    sessionInfo.phoneNotificationCache.push(newNotification);

    // Use NotificationSummaryAgent to process and rank notifications
    try {
      const ranking = await this.notificationSummaryAgent.handleContext({
        notifications: sessionInfo.phoneNotificationCache
      });
      sessionInfo.phoneNotificationRanking = ranking.map((n: any) => ({
        summary: n.summary,
        timestamp: new Date(n.timestamp).getTime() || Date.now()
      }));
      logger.debug('NotificationSummaryAgent ranking:', { ranking });
    } catch (error) {
      logger.error(error, `Error using NotificationSummaryAgent for session ${session.userId}`);
      // fallback: use manual summary as before
      sessionInfo.phoneNotificationRanking = sessionInfo.phoneNotificationCache
        .sort((a, b) => b.timestamp - a.timestamp)
        .map(notification => ({
          summary: `${notification.title}: ${notification.content}`,
          timestamp: notification.timestamp
        }));
    }

    // Update dashboard sections
    this.updateDashboardSections(session, sessionId);
  }

  /**
   * Fetch weather data for a given location
   */
  private async fetchWeatherData(session: TpaSession, sessionId: string, lat: number, lng: number, forceUpdate: boolean = false): Promise<void> {
    const logger = session.logger; // Use session logger to have session-specific logs with userId correlation.
    logger.debug({ lat, lng, forceUpdate, function: "fetchWeatherData" }, `Fetching weather data for session ${sessionId}`);
    const sessionInfo = this._activeSessions.get(sessionId);
    if (!sessionInfo) return;

    // Determine if we should fetch weather based on cache or forced update
    const shouldFetchWeather = forceUpdate ||
      !sessionInfo.weatherCache ||
      (Date.now() - (sessionInfo.weatherCache.timestamp || 0) > 60 * 60 * 1000); // 1 hour

    // TODO(isaiah): remove this check when we have a proper weather module.
    if (shouldFetchWeather || true) {
      try {
        const weatherModule = new WeatherModule();
        const weatherData = await weatherModule.fetchWeatherForecast(session, lat, lng);

        if (weatherData) {
          // Use metricSystemEnabled from session settings to decide units
          const useMetric = session.settings.getAugmentosSetting('metricSystemEnabled');
          logger.debug(`[Weather] Metric system enabled: ${useMetric}`);
          const temp = useMetric ? weatherData.temp_c : weatherData.temp_f;
          const unit = useMetric ? '°C' : '°F';

          sessionInfo.weatherCache = {
            timestamp: Date.now(),
            data: `${weatherData.condition}, ${temp}${unit}`
          };

          logger.debug(`Weather updated: ${sessionInfo.weatherCache.data}`);

          // Update dashboard with new weather info
          this.updateDashboardSections(session, sessionId);
        }
      } catch (error) {
        logger.error(error, `Error fetching weather for session ${sessionId}`);
      }
    }
  }

  /**
   * Handle location update event
   */
  private async handleLocationUpdate(session: TpaSession, sessionId: string, data: LocationUpdate): Promise<void> {
    const logger = session.logger; // Use session logger to have session-specific logs with userId correlation.
    logger.debug({ data, function: "handleLocationUpdate" }, `handleLocationUpdate for session ${sessionId}`);

    const sessionInfo = this._activeSessions.get(sessionId);
    if (!sessionInfo) return;

    // Extract lat, lng from location data
    const { lat, lng } = data;

    logger.debug(`[Location] Location updated: ${lat}, ${lng}`);

    // Skip if invalid coordinates
    if (typeof lat !== "number" || typeof lng !== "number") {
      logger.error({ data }, `Invalid location data for session ${session.userId}`);
      return;
    }

    // Determine timezone from coordinates
    let timezone: string | undefined;
    try {
      timezone = tzlookup(lat, lng);
    } catch (error) {
      logger.error(error, `Error looking up timezone for lat=${lat}, lng=${lng}: for session ${session.userId}`);
    }

    // Update location in session
    sessionInfo.latestLocation = {
      latitude: lat,
      longitude: lng,
      timezone: timezone || sessionInfo.latestLocation?.timezone
    };

    // Fetch weather data with the updated location
    await this.fetchWeatherData(session, sessionId, lat, lng);

    // Update dashboard with location info
    this.updateDashboardSections(session, sessionId);
  }

  /**
   * Handle battery update event
   */
  private handleBatteryUpdate(session: TpaSession, sessionId: string, data: GlassesBatteryUpdate): void {
    const logger = session.logger; // Use session logger to have session-specific logs with userId correlation.
    logger.debug({ data, function: "handleBatteryUpdate" }, `handleBatteryUpdate for session ${sessionId}`);
    const sessionInfo = this._activeSessions.get(sessionId);
    if (!sessionInfo) return;

    // Update battery level if it changed
    if (typeof data.level === 'number' && sessionInfo.batteryLevel !== data.level) {
      sessionInfo.batteryLevel = data.level;
      this.updateDashboardSections(session, sessionId);
    }
  }

  /**
   * Handle calendar event
   */
  private handleCalendarEvent(session: TpaSession, sessionId: string, event: CalendarEvent): void {
    const logger = session.logger; // Use session logger to have session-specific logs with userId correlation.
    logger.debug({ event, function: "handleCalendarEvent" }, `handleCalendarEvent for session ${sessionId}`);

    const sessionInfo = this._activeSessions.get(sessionId);
    if (!sessionInfo) return;

    // Validate event structure
    if (!event.title || !event.dtStart) {
      logger.error({ event }, `Invalid calendar event structure for session ${sessionId}`);
      return;
    }

    // Parse event start time
    const eventStart = new Date(event.dtStart).getTime();
    const now = Date.now();
    if (isNaN(eventStart)) {
      logger.error({ event }, `Invalid dtStart in calendar event for session ${sessionId}`);
      return;
    }

    // If the event is expired, do not save it
    if (eventStart < now) {
      logger.info({ title: event.title, dtStart: event.dtStart }, `Received expired calendar event, ignoring:`);
      return;
    }

    // If there is no saved event, or the new event is earlier, save it
    const currentEvent = sessionInfo.calendarEvent;
    if (!currentEvent) {
      sessionInfo.calendarEvent = event;
      this.updateDashboardSections(session, sessionId);
      return;
    }
    const currentEventStart = new Date(currentEvent.dtStart).getTime();
    if (isNaN(currentEventStart) || eventStart < currentEventStart) {
      sessionInfo.calendarEvent = event;
      this.updateDashboardSections(session, sessionId);
      return;
    }
    // Otherwise, keep the existing event (do not update)
    logger.info(`Received calendar event is not earlier than the current one, ignoring.`);
  }

  /**
   * Get all active dashboard sessions
   */
  public getActiveSessions(): string[] {
    return Array.from(this._activeSessions.keys());
  }

}

// ===========================================
// Additional Routes Configuration
// ===========================================

// Create and start the dashboard manager
const dashboardServer = new DashboardServer();


// Start the server
dashboardServer.start().then(() => {
  dashboardServer.logger.info(`Dashboard Manager TPA running on port ${PORT}`);
}).catch(error => {
  dashboardServer.logger.error(error, 'Failed to start Dashboard Manager');
  process.exit(1);
});

// Export the server instance for testing
export { dashboardServer };
