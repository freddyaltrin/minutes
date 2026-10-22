import { app } from 'electron'
import type { AppContext } from '../context'
import { RecordingService } from './recording'
import { ExportService } from './exports'
import { BackupService } from './backup'
import { ShortcutService } from './shortcuts'
import { CalendarService } from './calendar'
import { UpdaterService } from './updater'
import { TranscriptionService } from './whisper/transcription-service'
import { join } from 'node:path'

export interface Services {
  recording: RecordingService
  exports: ExportService
  backup: BackupService
  shortcuts: ShortcutService
  calendar: CalendarService
  updater: UpdaterService
  transcription: TranscriptionService
}

export function createServices(ctx: AppContext): Services {
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(process.cwd(), 'resources')
  const transcription = new TranscriptionService(ctx, { resourcesDir })
  const recording = new RecordingService(ctx, transcription)
  return {
    transcription,
    recording,
    exports: new ExportService(ctx),
    backup: new BackupService(ctx, () => recording.recordingsBytes()),
    shortcuts: new ShortcutService(ctx),
    calendar: new CalendarService(ctx),
    updater: new UpdaterService(ctx, { enabled: app.isPackaged })
  }
}
