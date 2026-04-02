declare module 'ffbinaries' {
  interface DownloadResult {
    filename: string
    path: string
    status: string
    code: string
  }
  function detectPlatform(): string
  function listVersions(callback: (err: Error | null, versions: string[]) => void): void
  function listPlatforms(): string[]
  function downloadBinaries(
    components: string | string[],
    options: { platform?: string; quiet?: boolean; destination?: string; version?: string },
    callback: (err: Error | null, results: DownloadResult[]) => void
  ): void
}
