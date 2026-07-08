import { hasNoAiApplicationPolicy } from './no-ai-policy-filter';

describe('hasNoAiApplicationPolicy', () => {
  it('rejects an Air-Apps-style disclaimer requiring no AI-generated assistance', () => {
    const result = hasNoAiApplicationPolicy(
      'Please submit your application without any AI-generated assistance. We want to see your own work.',
    );
    expect(result.reject).toBe(true);
  });

  it('rejects "use of AI ... will result in disqualification"', () => {
    const result = hasNoAiApplicationPolicy(
      'Note: use of AI tools during the assessment will result in disqualification.',
    );
    expect(result.reject).toBe(true);
  });

  it('rejects "no AI-generated applications"', () => {
    const result = hasNoAiApplicationPolicy('No AI-generated applications will be considered for this role.');
    expect(result.reject).toBe(true);
  });

  it('rejects "AI tools are not permitted in the application"', () => {
    const result = hasNoAiApplicationPolicy('AI tools are not permitted in the application process.');
    expect(result.reject).toBe(true);
  });

  it('does not reject a JD that merely discusses using AI tools on the job', () => {
    const result = hasNoAiApplicationPolicy("You'll use AI tools daily to speed up your backend workflow.");
    expect(result.reject).toBe(false);
  });

  it('does not reject a plain backend JD with no AI policy mentioned', () => {
    const result = hasNoAiApplicationPolicy('Node.js backend engineer building REST APIs and microservices.');
    expect(result.reject).toBe(false);
  });
});
