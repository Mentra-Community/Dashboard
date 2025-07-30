import { AppSession } from '@mentra/sdk';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

export interface WeatherSummary {
  condition: string;
  temp_f: number;
  temp_c: number;
}

export class WeatherModule {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    const OPEN_WEATHER_API_KEY = process.env.OPEN_WEATHER_API_KEY;
    if (!OPEN_WEATHER_API_KEY) {
      throw new Error('OPEN_WEATHER_API_KEY is not set in environment variables');
    }
    this.apiKey = OPEN_WEATHER_API_KEY;
    this.baseUrl = 'https://api.openweathermap.org';
  }

  /**
   * Fetch the current weather condition and temperature in Fahrenheit.
   */
  public async fetchWeatherForecast(session: AppSession, latitude: number, longitude: number): Promise<WeatherSummary | null> {
    const logger = session.logger;
    const url = `${this.baseUrl}/data/3.0/onecall?lat=${latitude}&lon=${longitude}&exclude=minutely,hourly,daily,alerts&units=imperial&appid=${this.apiKey}`;
    logger.info({ latitude, longitude }, `🌤️ Fetching weather data for lat=${latitude}, lon=${longitude}`);

    try {
      const response = await axios.get(url);
      const data = response.data;

      if (!data || !data.current || !data.current.weather || data.current.weather.length === 0) {
        logger.error({ data }, '❌ Unexpected weather API response structure:');
        return null;
      }

      logger.debug({ data }, `[Weather] Data: ${JSON.stringify(data)}`);

      const tempF = Math.round(data.current.temp);
      // Convert Fahrenheit to Celsius: (F - 32) * 5/9
      const tempC = Math.round((data.current.temp - 32) * 5 / 9);

      logger.debug({ latitude, longitude, tempF, tempC }, `[Weather] Temp F: ${tempF}, Temp C: ${tempC}`);

      return {
        condition: data.current.weather[0].main,
        temp_f: tempF,
        temp_c: tempC,
      };
    } catch (error) {
      logger.error(error, '❌ Error fetching weather data');
      return null;
    }
  }
}
