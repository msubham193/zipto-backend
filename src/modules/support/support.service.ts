import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import {
  SupportTicket,
  TicketMessage,
  TicketStatus,
  MessageSenderType,
} from './entities/support-ticket.entity';
import {
  CreateTicketDto,
  ReplyTicketDto,
  UpdateTicketStatusDto,
  GetTicketsQueryDto,
} from './dto/support-ticket.dto';

@Injectable()
export class SupportService {
  constructor(
    @InjectRepository(SupportTicket)
    private ticketRepository: Repository<SupportTicket>,
    @InjectRepository(TicketMessage)
    private messageRepository: Repository<TicketMessage>,
  ) {}

  private async generateTicketNumber(): Promise<string> {
    const count = await this.ticketRepository.count();
    return `TKT-${String(count + 1).padStart(4, '0')}`;
  }

  async createTicket(customerId: string, dto: CreateTicketDto): Promise<SupportTicket> {
    const ticketNumber = await this.generateTicketNumber();
    const ticket = this.ticketRepository.create({
      ticket_number: ticketNumber,
      subject: dto.subject,
      description: dto.description,
      category: dto.category,
      priority: dto.priority,
      booking_id: dto.booking_id,
      customer_id: customerId,
    });

    const saved = await this.ticketRepository.save(ticket);

    // Auto-create first message from description
    await this.messageRepository.save(
      this.messageRepository.create({
        ticket_id: saved.id,
        content: dto.description,
        sender_id: customerId,
        sender_type: MessageSenderType.CUSTOMER,
      }),
    );

    return this.getTicketById(saved.id);
  }

  async getAllTickets(query: GetTicketsQueryDto) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;

    const qb = this.ticketRepository
      .createQueryBuilder('ticket')
      .leftJoinAndSelect('ticket.customer', 'customer')
      .leftJoinAndSelect('ticket.assigned_to', 'assigned_to')
      .leftJoinAndSelect('ticket.messages', 'messages')
      .leftJoinAndSelect('messages.sender', 'msg_sender')
      .orderBy('ticket.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.status) {
      qb.andWhere('ticket.status = :status', { status: query.status });
    }
    if (query.priority) {
      qb.andWhere('ticket.priority = :priority', { priority: query.priority });
    }
    if (query.category) {
      qb.andWhere('ticket.category = :category', { category: query.category });
    }
    if (query.search) {
      qb.andWhere(
        '(ticket.ticket_number ILIKE :search OR ticket.subject ILIKE :search OR customer.name ILIKE :search)',
        { search: `%${query.search}%` },
      );
    }

    const [tickets, total] = await qb.getManyAndCount();

    return {
      data: tickets,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getTicketById(id: string): Promise<SupportTicket> {
    const ticket = await this.ticketRepository.findOne({
      where: { id },
      relations: ['customer', 'assigned_to', 'messages', 'messages.sender'],
      order: { messages: { created_at: 'ASC' } } as any,
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  async replyToTicket(
    ticketId: string,
    adminId: string,
    dto: ReplyTicketDto,
  ): Promise<TicketMessage> {
    const ticket = await this.ticketRepository.findOne({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket not found');

    // Move ticket to in_progress when admin replies
    if (ticket.status === TicketStatus.OPEN) {
      await this.ticketRepository.update(ticketId, {
        status: TicketStatus.IN_PROGRESS,
        assigned_to_id: adminId,
      });
    }

    return this.messageRepository.save(
      this.messageRepository.create({
        ticket_id: ticketId,
        content: dto.content,
        sender_id: adminId,
        sender_type: MessageSenderType.ADMIN,
      }),
    );
  }

  async updateTicketStatus(
    ticketId: string,
    dto: UpdateTicketStatusDto,
  ): Promise<SupportTicket> {
    const ticket = await this.ticketRepository.findOne({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket not found');

    const update: Partial<SupportTicket> = { status: dto.status };
    if (dto.assigned_to_id) update.assigned_to_id = dto.assigned_to_id;

    await this.ticketRepository.update(ticketId, update);
    return this.getTicketById(ticketId);
  }

  async getStats() {
    const [open, in_progress, resolved, closed] = await Promise.all([
      this.ticketRepository.count({ where: { status: TicketStatus.OPEN } }),
      this.ticketRepository.count({ where: { status: TicketStatus.IN_PROGRESS } }),
      this.ticketRepository.count({ where: { status: TicketStatus.RESOLVED } }),
      this.ticketRepository.count({ where: { status: TicketStatus.CLOSED } }),
    ]);

    return { open, in_progress, resolved, closed, total: open + in_progress + resolved + closed };
  }
}
