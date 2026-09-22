import { Module } from '@nestjs/common';

import { PluginDownloadController } from './plugin-download.controller';
import { PluginDownloadService } from './plugin-download.service';

/**
 * Serving the plugin a merchant installs (M20b.3).
 *
 * No database and no auth: the archives are files on disk and the routes are
 * public (ADR-095), so this module imports nothing.
 */
@Module({
  controllers: [PluginDownloadController],
  providers: [PluginDownloadService],
  exports: [PluginDownloadService],
})
export class PluginDownloadModule {}
