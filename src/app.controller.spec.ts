import { AppController } from './app.controller';
import { AppService } from './app.service';

function buildMockResponse() {
  const res: { status: jest.Mock; json: jest.Mock; redirect: jest.Mock } = {
    status: jest.fn(),
    json: jest.fn(),
    redirect: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as import('express').Response & { status: jest.Mock; json: jest.Mock; redirect: jest.Mock };
}

describe('AppController — main dashboard actions have zero gate (Apply/Dismiss)', () => {
  let appService: { dashboardJobApplied: jest.Mock; dashboardJobDismiss: jest.Mock };
  let controller: AppController;

  beforeEach(() => {
    appService = {
      dashboardJobApplied: jest.fn().mockResolvedValue(undefined),
      dashboardJobDismiss: jest.fn().mockResolvedValue(undefined),
    };
    controller = new AppController(appService as unknown as AppService);
  });

  it('Applied fires immediately with no password/confirmation and redirects to history', async () => {
    const res = buildMockResponse();
    await controller.dashboardJobApplied('job1', 't', 'c', '80', 'src', res);
    expect(appService.dashboardJobApplied).toHaveBeenCalledWith('job1', {
      title: 't', company: 'c', score: 80, source: 'src',
    });
    expect(res.redirect).toHaveBeenCalledWith('/history?tab=applied');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('Dismiss fires immediately with no password/confirmation and redirects home', async () => {
    const res = buildMockResponse();
    await controller.dashboardJobDismiss('job1', res);
    expect(appService.dashboardJobDismiss).toHaveBeenCalledWith('job1');
    expect(res.redirect).toHaveBeenCalledWith('/');
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('AppController — History page Revert requires a destination choice, not a password', () => {
  let appService: { revertJobStatus: jest.Mock };
  let controller: AppController;

  beforeEach(() => {
    appService = {
      revertJobStatus: jest.fn().mockResolvedValue({ ok: true, previousStatus: 'dismissed', newStatus: 'listing' }),
    };
    controller = new AppController(appService as unknown as AppService);
  });

  it('rejects an invalid destination (400) and does not change status', async () => {
    const res = buildMockResponse();
    await controller.revertJobStatus('https://example.com/job', 'somewhere-else', res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(appService.revertJobStatus).not.toHaveBeenCalled();
  });

  it('rejects a missing destination (400) and does not change status', async () => {
    const res = buildMockResponse();
    await controller.revertJobStatus('https://example.com/job', undefined as unknown as string, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(appService.revertJobStatus).not.toHaveBeenCalled();
  });

  it('destination "listing" calls the service with "listing" and returns 200', async () => {
    const res = buildMockResponse();
    await controller.revertJobStatus('https://example.com/job', 'listing', res);
    expect(appService.revertJobStatus).toHaveBeenCalledWith('https://example.com/job', 'listing');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('destination "dismissed" calls the service with "dismissed" and returns 200', async () => {
    const res = buildMockResponse();
    await controller.revertJobStatus('https://example.com/job', 'dismissed', res);
    expect(appService.revertJobStatus).toHaveBeenCalledWith('https://example.com/job', 'dismissed');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('destination "applied" calls the service with "applied" and returns 200', async () => {
    const res = buildMockResponse();
    await controller.revertJobStatus('https://example.com/job', 'applied', res);
    expect(appService.revertJobStatus).toHaveBeenCalledWith('https://example.com/job', 'applied');
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('AppController — read-only endpoints are unaffected', () => {
  it('home() renders with no gate', async () => {
    const appService = { renderDashboard: jest.fn().mockResolvedValue('<html></html>') };
    const controller = new AppController(appService as unknown as AppService);
    const html = await controller.home();
    expect(html).toBe('<html></html>');
    expect(appService.renderDashboard).toHaveBeenCalledWith();
  });

  it('appliedJobsApi() returns data with no gate', async () => {
    const appService = { getAppliedJobs: jest.fn().mockResolvedValue([{ jobId: '1' }]) };
    const controller = new AppController(appService as unknown as AppService);
    const result = await controller.appliedJobsApi();
    expect(result).toEqual([{ jobId: '1' }]);
  });
});
