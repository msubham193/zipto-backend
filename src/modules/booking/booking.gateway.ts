import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  namespace: 'booking',
})
export class BookingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  // Store pending offers for offline drivers (userId -> offer data)
  private pendingOffers = new Map<string, any>();

  constructor(private jwtService: JwtService) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth.token || client.handshake.headers.authorization;
      if (!token) {
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token.replace('Bearer ', ''));
      client.data.user = payload;

      // Join room based on user ID
      await client.join(`user_${payload.sub}`);
      console.log(`Client connected: ${client.id}, User: ${payload.sub}`);

      // Deliver any pending offer that was stored while they were offline
      const pendingOffer = this.pendingOffers.get(payload.sub);
      if (pendingOffer) {
        console.log(`[BookingGateway] Delivering pending offer to reconnected user ${payload.sub}`);
        client.emit('booking_offer', pendingOffer);
        this.pendingOffers.delete(payload.sub);
      }
    } catch (error) {
      console.error('Connection error:', error.message);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
  }

  // Helper method to emit booking offer to a specific driver
  async emitBookingOffer(driverId: string, bookingData: any) {
    const room = `user_${driverId}`;
    const sockets = await this.server.in(room).fetchSockets();
    console.log(`[BookingGateway] emitBookingOffer to room=${room}, connected sockets: ${sockets.length}`);

    if (sockets.length > 0) {
      this.server.to(room).emit('booking_offer', bookingData);
    } else {
      // Driver is offline (e.g. switched to another app on same phone)
      // Store the offer and deliver when they reconnect
      console.log(`[BookingGateway] Driver ${driverId} offline, storing pending offer`);
      this.pendingOffers.set(driverId, bookingData);

      // Auto-expire pending offer after 30 seconds
      setTimeout(() => {
        if (this.pendingOffers.get(driverId) === bookingData) {
          this.pendingOffers.delete(driverId);
          console.log(`[BookingGateway] Pending offer expired for driver ${driverId}`);
        }
      }, 30000);
    }
  }

  // Helper to notify user about booking status
  notifyUser(userId: string, event: string, data: any) {
    this.server.to(`user_${userId}`).emit(event, data);
  }
}