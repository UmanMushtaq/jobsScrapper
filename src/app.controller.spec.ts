import { AppController } from './app.controller';
import { AppService } from './app.service';

function buildMockResponse() {
  const res: { status: jest.Mock; json: jest.Mock } = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as import('express').Response & { status: jest.Mock; json: jest.Mock };
}

const CORRECT_PASSWORD = 'correct-horse-battery-staple';

describe('AppController — dashboard status-change password gate', () => {
  let appService: {
    dashboardJobApplied: jest.Mock;
    dashboardJobDismiss: jest.Mock;
    revertJobStatus: jest.Mock;
  };
  let controller: AppController;
  const ORIGINAL_ENV = process.env.DASHBOARD_STATUS_PASSWORD;

  beforeEach(() => {
    appService = {
      dashboardJobApplied: jest.fn().mockResolvedValue(undefined),
      dashboardJobDismiss: jest.fn().mockResolvedValue(undefined),
      revertJobStatus: jest.fn().mockResolvedValue({ ok: true, previousStatus: 'applied' }),
    };
    controller = new AppController(appService as unknown as AppService);
    process.env.DASHBOARD_STATUS_PASSWORD = CORRECT_PASSWORD;
  });

  afterEach(() => {
    process.env.DASHBOARD_STATUS_PASSWORD = ORIGINAL_ENV;
    jest.clearAllMocks();
  });

  it('rejects Applied with no password (401) and does not change status', async () => {
    const res = buildMockResponse();
    await controller.dashboardJobApplied('job1', 't', 'c', '80', 'src', undefined as unknown as string, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(appService.dashboardJobApplied).not.toHaveBeenCalled();
  });

  it('rejects Applied with the wrong password (401) and does not change status', async () => {
    const res = buildMockResponse();
    await controller.dashboardJobApplied('job1', 't', 'c', '80', 'src', 'wrong-password', res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(appService.dashboardJobApplied).not.toHaveBeenCalled();
  });

  it('accepts Applied with the correct password, changes status, returns 200', async () => {
    const res = buildMockResponse();
    await controller.dashboardJobApplied('job1', 't', 'c', '80', 'src', CORRECT_PASSWORD, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(appService.dashboardJobApplied).toHaveBeenCalledWith('job1', {
      title: 't', company: 'c', score: 80, source: 'src',
    });
  });

  it('rejects Dismiss with no password and does not change status', async () => {
    const res = buildMockResponse();
    await controller.dashboardJobDismiss('job1', undefined as unknown as string, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(appService.dashboardJobDismiss).not.toHaveBeenCalled();
  });

  it('rejects Dismiss with the wrong password and does not change status', async () => {
    const res = buildMockResponse();
    await controller.dashboardJobDismiss('job1', 'wrong-password', res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(appService.dashboardJobDismiss).not.toHaveBeenCalled();
  });

  it('accepts Dismiss with the correct password, changes status, returns 200', async () => {
    const res = buildMockResponse();
    await controller.dashboardJobDismiss('job1', CORRECT_PASSWORD, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(appService.dashboardJobDismiss).toHaveBeenCalledWith('job1');
  });

  it('Revert follows the same gate: rejects with no password', async () => {
    const res = buildMockResponse();
    await controller.revertJobStatus('https://example.com/job', undefined as unknown as string, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(appService.revertJobStatus).not.toHaveBeenCalled();
  });

  it('Revert follows the same gate: rejects with the wrong password', async () => {
    const res = buildMockResponse();
    await controller.revertJobStatus('https://example.com/job', 'wrong-password', res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(appService.revertJobStatus).not.toHaveBeenCalled();
  });

  it('Revert follows the same gate: accepts with the correct password', async () => {
    const res = buildMockResponse();
    await controller.revertJobStatus('https://example.com/job', CORRECT_PASSWORD, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(appService.revertJobStatus).toHaveBeenCalledWith('https://example.com/job');
  });

  it('fails closed when DASHBOARD_STATUS_PASSWORD is not configured at all', async () => {
    delete process.env.DASHBOARD_STATUS_PASSWORD;
    const res = buildMockResponse();
    await controller.dashboardJobApplied('job1', 't', 'c', '80', 'src', 'anything', res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(appService.dashboardJobApplied).not.toHaveBeenCalled();
  });
});

describe('AppController — read-only endpoints are unaffected by the password gate', () => {
  it('home() renders without requiring a password', async () => {
    const appService = { renderDashboard: jest.fn().mockResolvedValue('<html></html>') };
    const controller = new AppController(appService as unknown as AppService);
    const html = await controller.home();
    expect(html).toBe('<html></html>');
    expect(appService.renderDashboard).toHaveBeenCalledWith();
  });

  it('appliedJobsApi() returns data without requiring a password', async () => {
    const appService = { getAppliedJobs: jest.fn().mockResolvedValue([{ jobId: '1' }]) };
    const controller = new AppController(appService as unknown as AppService);
    const result = await controller.appliedJobsApi();
    expect(result).toEqual([{ jobId: '1' }]);
  });
});
