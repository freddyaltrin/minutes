import type { MinutesApi } from '../shared/api'

declare global {
  interface Window {
    minutes: MinutesApi
    minutesPlatform: NodeJS.Platform
  }
}
export {}
