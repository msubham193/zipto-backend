import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity';

export enum TicketStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  RESOLVED = 'resolved',
  CLOSED = 'closed',
}

export enum TicketPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  URGENT = 'urgent',
}

export enum TicketCategory {
  BOOKING = 'booking',
  PAYMENT = 'payment',
  DRIVER = 'driver',
  TECHNICAL = 'technical',
  OTHER = 'other',
}

@Entity('support_tickets')
export class SupportTicket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 20, unique: true })
  @Index()
  ticket_number: string;

  @Column({ type: 'varchar', length: 255 })
  subject: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'enum', enum: TicketCategory, default: TicketCategory.OTHER })
  category: TicketCategory;

  @Column({ type: 'enum', enum: TicketPriority, default: TicketPriority.MEDIUM })
  priority: TicketPriority;

  @Column({ type: 'enum', enum: TicketStatus, default: TicketStatus.OPEN })
  @Index()
  status: TicketStatus;

  @Column({ type: 'uuid' })
  @Index()
  customer_id: string;

  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'customer_id' })
  customer: User;

  @Column({ type: 'uuid', nullable: true })
  assigned_to_id: string;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'assigned_to_id' })
  assigned_to: User;

  @Column({ type: 'varchar', length: 50, nullable: true })
  booking_id: string;

  @OneToMany(() => TicketMessage, (msg) => msg.ticket, { cascade: true })
  messages: TicketMessage[];

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}

export enum MessageSenderType {
  CUSTOMER = 'customer',
  ADMIN = 'admin',
  SYSTEM = 'system',
}

@Entity('ticket_messages')
export class TicketMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  ticket_id: string;

  @ManyToOne(() => SupportTicket, (ticket) => ticket.messages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket: SupportTicket;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'uuid' })
  sender_id: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'sender_id' })
  sender: User;

  @Column({ type: 'enum', enum: MessageSenderType })
  sender_type: MessageSenderType;

  @CreateDateColumn()
  created_at: Date;
}
