import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemSetting } from './entities/system-setting.entity';
import { SystemSettingsService } from './system-settings.service';

@Module({
  imports: [TypeOrmModule.forFeature([SystemSetting])],
  providers: [SystemSettingsService],
  exports: [SystemSettingsService],
})
export class SettingsModule {}
