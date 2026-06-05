import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionLog } from './entities/transaction-log.entity';
import { TransactionLogService } from './transaction-log.service';

/**
 * Global so any service can inject TransactionLogService to append ledger
 * entries without importing this module everywhere.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([TransactionLog])],
  providers: [TransactionLogService],
  exports: [TransactionLogService],
})
export class TransactionLogModule {}
