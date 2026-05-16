import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ZiptoShieldLedger } from './entities/zipto-shield-ledger.entity';
import { ZiptoShieldTransaction } from './entities/zipto-shield-transaction.entity';
import { ZiptoShieldService } from './zipto-shield.service';
import { ZiptoShieldController } from './zipto-shield.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ZiptoShieldLedger, ZiptoShieldTransaction])],
  providers: [ZiptoShieldService],
  controllers: [ZiptoShieldController],
  exports: [ZiptoShieldService],
})
export class ZiptoShieldModule {}