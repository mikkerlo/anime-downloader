import { join } from 'path'

export function windowIconPath(mainDir: string, platform: NodeJS.Platform): string {
  return join(mainDir, '../../resources', platform === 'win32' ? 'icon.ico' : 'icon.png')
}
