// The merge's video codec choices: `copy` plus the HEVC encoders `checkFfmpeg`
// reports. Shared by Settings → Merging and the export dialog (#576).

export interface VideoCodecOption {
  value: string
  label: string
  /** The ffmpeg encoder it needs; none for `copy`. */
  encoder?: string
}

export const VIDEO_CODEC_OPTIONS: readonly VideoCodecOption[] = [
  { value: 'copy', label: 'None (copy, fastest)' },
  { value: 'libx265', label: 'H.265 (CPU)', encoder: 'libx265' },
  { value: 'hevc_nvenc', label: 'H.265 (NVIDIA GPU)', encoder: 'hevc_nvenc' },
  { value: 'hevc_amf', label: 'H.265 (AMD GPU)', encoder: 'hevc_amf' },
  { value: 'hevc_qsv', label: 'H.265 (Intel QSV)', encoder: 'hevc_qsv' },
  { value: 'hevc_videotoolbox', label: 'H.265 (macOS VideoToolbox)', encoder: 'hevc_videotoolbox' }
]

/** The options this ffmpeg can run: `copy`, and each encoder in `encoders`. */
export function availableCodecs(encoders: readonly string[]): VideoCodecOption[] {
  return VIDEO_CODEC_OPTIONS.filter((c) => !c.encoder || encoders.includes(c.encoder))
}
