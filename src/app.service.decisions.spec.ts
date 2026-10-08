jest.mock('./job-search/redis-store', () => ({
  ...jest.requireActual<typeof import('./job-search/redis-store')>(
    './job-search/redis-store',
  ),
  redisGetDashboardJobs: jest.fn(),
  redisDeleteDashboardJob: jest.fn().mockResolvedValue(undefined),
  redisSaveAppliedJob: jest.fn().mockResolvedValue(undefined),
  redisRecordJobDecisionHistory: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./job-search/run', () => ({
  ...jest.requireActual<typeof import('./job-search/run')>('./job-search/run'),
  markJobDecision: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./job-search/telegram', () => ({
  ...jest.requireActual<typeof import('./job-search/telegram')>(
    './job-search/telegram',
  ),
  resolveJobRef: jest.fn(),
  resolveJobMeta: jest.fn(),
  answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
  editTelegramMessage: jest.fn().mockResolvedValue(undefined),
}));

import { AppService } from './app.service';
import {
  redisDeleteDashboardJob,
  redisGetDashboardJobs,
  redisRecordJobDecisionHistory,
  redisSaveAppliedJob,
} from './job-search/redis-store';
import { markJobDecision } from './job-search/run';
import {
  hashJobUrl,
  resolveJobMeta,
  resolveJobRef,
} from './job-search/telegram';

const URL = 'https://jobs.example.com/backend-engineer-42';
const JOB_ID = hashJobUrl(URL);
const CARD = {
  jobId: JOB_ID,
  foundAt: 1_790_000_000_000,
  match: {
    score: 81,
    job: {
      canonicalUrl: URL,
      title: 'Backend Engineer',
      company: 'Acme',
      countryCode: 'FR',
      locationLabel: 'Paris',
      workMode: 'hybrid',
    },
  },
};

function telegramUpdate(action: 'a' | 'd') {
  return {
    callback_query: {
      id: 'cb1',
      data: `${action}:${JOB_ID}`,
      message: {
        message_id: 7,
        chat: { id: 99 },
        text: 'Backend Engineer @ Acme',
      },
    },
  };
}

describe('Applied/Dismissed — Telegram and URL endpoints behave like the dashboard buttons', () => {
  const ORIGINAL_ENV = process.env;
  let service: AppService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, TELEGRAM_BOT_TOKEN: 'token' };
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    (redisGetDashboardJobs as jest.Mock).mockResolvedValue([CARD]);
    (resolveJobRef as jest.Mock).mockResolvedValue(URL);
    (resolveJobMeta as jest.Mock).mockResolvedValue({
      title: 'Backend Engineer',
      company: 'Acme',
      score: 81,
      source: 'apec.fr',
    });
    service = new AppService();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('Telegram ✅ marks applied, adds the job to the Applied tab and deletes the card', async () => {
    await service.handleTelegramWebhook(telegramUpdate('a'), '');
    expect(markJobDecision).toHaveBeenCalledWith(
      'applied',
      URL,
      expect.objectContaining({ title: 'Backend Engineer', company: 'Acme' }),
    );
    expect(redisSaveAppliedJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        title: 'Backend Engineer',
        company: 'Acme',
        score: 81,
      }),
    );
    expect(redisRecordJobDecisionHistory).toHaveBeenCalledWith(
      'applied',
      expect.objectContaining({ foundAt: CARD.foundAt }),
    );
    expect(redisDeleteDashboardJob).toHaveBeenCalledWith(JOB_ID);
  });

  it('Telegram ❌ marks dismissed and deletes the card, without an Applied entry', async () => {
    await service.handleTelegramWebhook(telegramUpdate('d'), '');
    expect(markJobDecision).toHaveBeenCalledWith(
      'dismissed',
      URL,
      expect.any(Object),
    );
    expect(redisSaveAppliedJob).not.toHaveBeenCalled();
    expect(redisDeleteDashboardJob).toHaveBeenCalledWith(JOB_ID);
  });

  it('Telegram ✅ still fills the Applied tab from the stored meta when the card has already expired', async () => {
    (redisGetDashboardJobs as jest.Mock).mockResolvedValue([]);
    await service.handleTelegramWebhook(telegramUpdate('a'), '');
    expect(redisSaveAppliedJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        title: 'Backend Engineer',
        company: 'Acme',
      }),
    );
  });

  it('the URL mark endpoints find the card by normalized URL and delete it', async () => {
    await service.markApplied(`${URL}/?utm_source=telegram`, {
      title: 'Backend Engineer',
      company: 'Acme',
      score: 81,
    });
    expect(redisSaveAppliedJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID }),
    );
    expect(redisDeleteDashboardJob).toHaveBeenCalledWith(JOB_ID);

    jest.clearAllMocks();
    (redisGetDashboardJobs as jest.Mock).mockResolvedValue([CARD]);
    await service.markDismissed(URL);
    expect(markJobDecision).toHaveBeenCalledWith(
      'dismissed',
      URL,
      expect.any(Object),
    );
    expect(redisDeleteDashboardJob).toHaveBeenCalledWith(JOB_ID);
  });

  it('the dashboard buttons keep their behaviour', async () => {
    await service.dashboardJobApplied(JOB_ID, {
      title: 'Backend Engineer',
      company: 'Acme',
      score: 81,
    });
    expect(markJobDecision).toHaveBeenCalledWith(
      'applied',
      URL,
      expect.any(Object),
    );
    expect(redisSaveAppliedJob).toHaveBeenCalledTimes(1);
    expect(redisDeleteDashboardJob).toHaveBeenCalledWith(JOB_ID);

    jest.clearAllMocks();
    (redisGetDashboardJobs as jest.Mock).mockResolvedValue([CARD]);
    await service.dashboardJobDismiss(JOB_ID);
    expect(markJobDecision).toHaveBeenCalledWith(
      'dismissed',
      URL,
      expect.any(Object),
    );
    expect(redisSaveAppliedJob).not.toHaveBeenCalled();
    expect(redisDeleteDashboardJob).toHaveBeenCalledWith(JOB_ID);
  });
});
