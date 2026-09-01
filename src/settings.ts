/** When a PDF you open should become markable.
 *
 *  This used to be two toggles that interacted — "reopen marked-up PDFs" and
 *  "open every PDF" — which is three states wearing two switches, and the
 *  combination that means "never" was not obvious from either of them.
 */
export type OpenMode = "never" | "marked" | "always";

export interface PalimpsestSettings {
  openMode: OpenMode;
}

export const DEFAULT_SETTINGS: PalimpsestSettings = {
  openMode: "marked",
};

/** Read whatever is on disk, including the old two-boolean shape. */
export function migrateSettings(raw: unknown): PalimpsestSettings {
  const data = (raw ?? {}) as Partial<PalimpsestSettings> & {
    reopenMarkedUp?: boolean;
    takeOverAllPdfs?: boolean;
  };

  if (data.openMode) return { openMode: data.openMode };
  if (data.takeOverAllPdfs) return { openMode: "always" };
  if (data.reopenMarkedUp === false) return { openMode: "never" };
  return { ...DEFAULT_SETTINGS };
}
