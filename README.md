# Dashboard TPA

A system Third-Party Application (TPA) for AugmentOS that provides dashboard functionality for AR glasses. The Dashboard TPA manages the display of system information including time, battery status, weather, notifications, and calendar events on the AR glasses HUD.

## Features

- **System Information Display**: Shows current time, battery level, and connection status
- **Weather Integration**: Displays current weather conditions based on user location
- **Smart Notifications**: Processes and ranks phone notifications using AI agents
- **Calendar Integration**: Shows upcoming calendar events with smart timing
- **Location Awareness**: Automatically detects timezone and fetches location-based weather
- **Settings Integration**: Responds to AugmentOS system settings changes (metric/imperial units)

## Prerequisites

- [Bun](https://bun.sh/) for JavaScript runtime
- AugmentOS API key
- Google Gemini API key (for notification processing)

## Setup

1. Clone the repository

2. Install dependencies:
   ```bash
   bun install
   ```

3. Set environment variables:
   ```bash
   export AUGMENTOS_API_KEY=your_api_key_here
   export PORT=80  # Optional, defaults to 80
   ```

4. Start the application:
   ```bash
   bun run dev
   ```

## Development

### Project Structure

```
/src
  /agents             # AI agents for processing notifications
  /dashboard-modules  # Dashboard-specific modules (weather, etc.)
  /text-utils         # Text formatting utilities
  index.ts            # Main TPA server implementation
```

### Key Technologies

- **AugmentOS SDK**: Dashboard API integration for AR glasses
- **Google Gemini**: AI-powered notification processing and ranking
- **LangChain**: Agent framework for AI functionality
- **Express**: HTTP server for TPA endpoints
- **TypeScript**: Type-safe development

### Dashboard Sections

The dashboard displays information in four sections:
- **Top Left**: Date/time and battery percentage
- **Top Right**: Weather conditions and calendar events
- **Bottom Left**: Prioritized phone notifications
- **Bottom Right**: (Currently unused)

## License

This project is proprietary and confidential.