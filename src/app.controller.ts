import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Post,
  Query,
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

  @Get('history')
  @Header('content-type', 'text/html; charset=utf-8')
  async history(): Promise<string> {
    return this.appService.getHistoryPage();
  }

  @Get('jobs/tailored-cv')
  @Header('content-type', 'text/html; charset=utf-8')
  async tailoredCv(@Query('hash') hash: string): Promise<string> {
    return this.appService.getTailoredCvPage(hash ?? '');
  }

  @Get('health')
  async health() {
    return this.appService.getHealth();
  }

  @Get('test-gemini')
  async testGemini() {
    return this.appService.testGemini();
  }

  @Get('api/gemini-status')
  async geminiStatus() {
    return this.appService.getGeminiStatusLite();
  }

  @Get('debug/keys')
  async validateKeys(@Query('force') force?: string) {
    return this.appService.validateGeminiKeys(force === 'true');
  }

  @Post('run-now')
  async runNow(@Res() response: Response): Promise<void> {
    await this.appService.runNow();
    response.redirect('/');
  }

  @Post('jobs/applied')
  async markApplied(
    @Body('url') url: string,
    @Body('title') title: string,
    @Body('company') company: string,
    @Body('score') score: string,
    @Body('source') source: string,
    @Res() response: Response,
  ): Promise<void> {
    await this.appService.markApplied(url, { title, company, score: Number(score) || 0, source });
    response.redirect('/history?tab=applied');
  }

  @Post('jobs/dismissed')
  async markDismissed(
    @Body('url') url: string,
    @Body('title') title: string,
    @Body('company') company: string,
    @Body('score') score: string,
    @Body('source') source: string,
    @Res() response: Response,
  ): Promise<void> {
    await this.appService.markDismissed(url, { title, company, score: Number(score) || 0, source });
    response.redirect('/history?tab=dismissed');
  }

  @Post('telegram/webhook')
  async telegramWebhook(
    @Body() update: Record<string, unknown>,
    @Headers('x-telegram-bot-api-secret-token') secret: string,
  ): Promise<{ ok: boolean }> {
    await this.appService.handleTelegramWebhook(update, secret);
    return { ok: true };
  }
}

