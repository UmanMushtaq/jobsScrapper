import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  async home(): Promise<string> {
    return this.appService.renderDashboard();
  }

  @Get('health')
  async health() {
    return this.appService.getHealth();
  }

  @Post('run-now')
  async runNow(@Res() response: Response): Promise<void> {
    await this.appService.runNow();
    response.redirect('/');
  }

  @Post('jobs/applied')
  async markApplied(
    @Body('url') url: string,
    @Res() response: Response,
  ): Promise<void> {
    await this.appService.markApplied(url);
    response.redirect('/');
  }

  @Post('jobs/dismissed')
  async markDismissed(
    @Body('url') url: string,
    @Res() response: Response,
  ): Promise<void> {
    await this.appService.markDismissed(url);
    response.redirect('/');
  }
}

