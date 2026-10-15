/** Settings panel commands provided by the client settings shell. */
import type {} from '@deepseek-ai/cordis'

/** Client navigation commands over the settings shell's shared viewing state. */
export interface SettingsShell {
  /**
   * Open the settings panel on a registered section. An unregistered id opens
   * the panel on its first section without throwing; the requested id is kept,
   * so a section registered later under that id becomes selected. With no
   * registered sections, the panel opens with an empty content column.
   * @param sectionId - id registered in `settings.section`.
   */
  openSection(sectionId: string): void
  /** Close the settings panel and clear its section selection. */
  close(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Settings panel navigation, provided by ui-settings-general. */
    settingsShell: SettingsShell
  }
}
