import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

// One row per active session (device/app install). Replaces the old
// single-column `users.refresh_token`, which overwrote itself on every login
// and silently killed every other device's session. Storing a hash (not the
// raw JWT) so a DB read never exposes a usable bearer token.
@Entity('refresh_tokens')
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  user_id: string;

  @Column({ type: 'varchar', length: 64 })
  @Index()
  token_hash: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  device_id: string | null;

  @Column({ type: 'timestamp' })
  expires_at: Date;

  @Column({ type: 'timestamp', nullable: true })
  last_used_at: Date | null;

  @CreateDateColumn()
  created_at: Date;
}
