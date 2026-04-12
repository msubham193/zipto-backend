import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/**
 * Exotel masked-call service.
 *
 * Uses Exotel's "Connect" (click-to-call) API to bridge two parties
 * without exposing either phone number. Exotel calls the agent (rider)
 * first; when the rider picks up, it dials the customer. Both parties
 * see only the Exotel ExoPhone (virtual number).
 *
 * Docs: https://developer.exotel.com/api/calls-connect
 *
 * Required env vars:
 *   EXOTEL_SID          — Your Exotel Account SID (e.g. zipto1)
 *   EXOTEL_API_KEY      — API key from Exotel dashboard
 *   EXOTEL_API_TOKEN    — API token from Exotel dashboard
 *   EXOTEL_EXOPHONE     — Virtual number / ExoPhone (e.g. 08040271a1b)
 */
@Injectable()
export class ExotelService {
  private readonly logger = new Logger(ExotelService.name);

  private readonly sid: string;
  private readonly apiKey: string;
  private readonly apiToken: string;
  private readonly exophone: string;

  constructor(private configService: ConfigService) {
    this.sid       = (this.configService.get<string>('externalServices.exotel.sid') || '').trim();
    this.apiKey    = (this.configService.get<string>('externalServices.exotel.apiKey') || '').trim();
    this.apiToken  = (this.configService.get<string>('externalServices.exotel.apiToken') || '').trim();
    this.exophone  = (this.configService.get<string>('externalServices.exotel.exophone') || '').trim();

    this.logger.log(
      `Exotel config — sid: ${this.sid || 'MISSING'}, exophone: ${this.exophone || 'MISSING'}, apiKey: ${this.apiKey ? this.apiKey.substring(0, 6) + '...' : 'MISSING'}`,
    );
  }

  /**
   * Initiate a masked voice call.
   * Exotel calls `from` (rider) first. When answered, it dials `to` (customer).
   * Both legs show the ExoPhone — neither party sees the other's real number.
   *
   * @returns Exotel Call SID on success, throws on failure.
   */
  async initiateVoiceBridge(riderPhone: string, customerPhone: string): Promise<string> {
    if (!this.sid || !this.apiKey || !this.apiToken || !this.exophone) {
      throw new Error('Exotel is not fully configured. Check EXOTEL_SID / EXOTEL_API_KEY / EXOTEL_API_TOKEN / EXOTEL_EXOPHONE.');
    }

    const normalize = (p: string) =>
      p.startsWith('+91') ? p.replace('+91', '0') : p.startsWith('+') ? p : `0${p.replace(/\D/g, '').slice(-10)}`;

    const from = normalize(riderPhone);    // rider — gets called first
    const to   = normalize(customerPhone); // customer — bridged when rider answers

    const url = `https://api.exotel.com/v1/Accounts/${this.sid}/Calls/connect.json`;

    try {
      const response = await axios.post(
        url,
        new URLSearchParams({
          From:     from,
          To:       to,
          CallerId: this.exophone,
          TimeLimit: '600', // max 10 min per call
          Record:   'false',
        }),
        {
          auth: { username: this.apiKey, password: this.apiToken },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000,
        },
      );

      const callSid: string = response.data?.Call?.Sid || response.data?.sid || 'unknown';
      this.logger.log(`[Exotel] Bridge initiated — rider: ${from}, customer: ${to}, SID: ${callSid}`);
      return callSid;
    } catch (error: unknown) {
      const msg = (error as any)?.response?.data
        ? JSON.stringify((error as any).response.data)
        : (error as Error)?.message || JSON.stringify(error);
      this.logger.error(`[Exotel] Voice bridge failed — rider: ${from}, customer: ${to}: ${msg}`);
      throw new Error(`Failed to initiate call: ${msg}`);
    }
  }
}
