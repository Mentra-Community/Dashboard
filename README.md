# Flex: Workout Tracking App for AR Glasses

Flex is a minimalist workout tracking app for AR glasses with a HUD display limited to 5 lines of text. The app is controlled entirely through voice commands and focuses on recording exercises, weights, and reps while showing historical data for progressive overload.

## Features

- Minimalist display optimized for AR glasses
- Voice-only control for hands-free operation during workouts
- Exercise tracking with weight and rep recording
- Historical workout data for progressive overload
- MongoDB storage for persistence

## Prerequisites

- [Bun](https://bun.sh/) for JavaScript runtime
- [Docker](https://www.docker.com/) and Docker Compose for containerization
- AugmentOS API key
- Google Gemini API key

## Setup

1. Clone the repository

2. Copy the example environment file and update with your credentials:
   ```
   cp example.env .env
   ```

3. Install dependencies:
   ```
   bun install
   ```

4. Start the development server:
   ```
   bun run docker:dev
   ```

## Usage

The app provides the following voice commands:

### Global Commands

- "Show workout app": Bring the app into view
- "Hide workout app": Temporarily hide the app from view
- "Home": Return to exercise selection screen

### Exercise Selection Screen

- "Select [exercise name]": Open the selected exercise
- "New exercise [name]": Create and open a new exercise
- "Rename [old name] to [new name]": Change the name of an exercise
- "Delete [exercise name]": Remove an exercise from the list

### Exercise History/Active Screen

- "Log set [weight] by [reps]": Record a new set (e.g., "Log set 185 by 8")
- "Edit last set to [weight] by [reps]": Correct a mistake in the most recent set
- "Complete exercise": Finish the current exercise and return to selection screen
- "Back": Return to exercise selection screen
- "Delete today's data": Remove all sets logged today

## Development

### Project Structure

```
/flex
  /docker             # Docker configuration
  /docs               # Documentation and design docs
  /src                # Source code
    /models           # MongoDB schemas
    /services         # Business logic
      /display        # Display formatting services
      /intent         # Intent detection system
      /session        # Session management
    app.ts            # Main application
    index.ts          # Entry point
```

### Key Technologies

- AugmentOS SDK for AR glasses integration
- Google Gemini for natural language understanding
- Express for HTTP server
- MongoDB with Mongoose for data persistence

## License

This project is proprietary and confidential.