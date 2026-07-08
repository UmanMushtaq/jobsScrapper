import { isFrontendPrimaryStack, isMarketingEngineeringRole } from './stack-filter';

describe('isFrontendPrimaryStack', () => {
  it('rejects a title leading with Angular and only a passing Node.js mention', () => {
    const result = isFrontendPrimaryStack(
      'Développeur Fullstack Angular / Node.js',
      'Nous recherchons un développeur avec une excellente maîtrise d\'Angular. ' +
        'Une bonne connaissance de Node.js est un plus.',
    );
    expect(result.reject).toBe(true);
  });

  it('accepts a backend title with a single passing Angular mention and heavy Node/NestJS content', () => {
    const result = isFrontendPrimaryStack(
      'Senior Backend Engineer',
      'We are building a NestJS/Node.js microservices platform with PostgreSQL and RabbitMQ. ' +
        'Our frontend is Angular, but this role is 100% backend focused on Node.js and NestJS APIs.',
    );
    expect(result.reject).toBe(false);
  });

  it('accepts a fullstack title where Node.js is co-primary with 3+ mentions despite some Angular mentions', () => {
    const result = isFrontendPrimaryStack(
      'Fullstack TypeScript Developer (Node.js)',
      'You will work across our stack: Node.js backend services, Node.js CLI tooling, and a Nest.js ' +
        'API gateway. Some familiarity with Angular is useful since our admin panel uses Angular ' +
        'and the marketing site uses Angular too.',
    );
    expect(result.reject).toBe(false);
  });
});

describe('isMarketingEngineeringRole', () => {
  it('rejects "GTM MarTech Engineer (Growth & Attribution)" by title', () => {
    const result = isMarketingEngineeringRole(
      'GTM MarTech Engineer (Growth & Attribution)',
      'Join our growth team building marketing infrastructure.',
    );
    expect(result.reject).toBe(true);
  });

  it('rejects a description dominated by marketing-tooling keywords with no backend core', () => {
    const result = isMarketingEngineeringRole(
      'Marketing Systems Developer',
      'You will manage our Google Tag Manager setup, configure Meta Pixel and Meta CAPI events, ' +
        'integrate HubSpot workflows, build attribution models, and optimize ROAS across ad platforms ' +
        'using Zapier automations.',
    );
    expect(result.reject).toBe(true);
  });

  it('accepts a backend role that merely lists one HubSpot integration', () => {
    const result = isMarketingEngineeringRole(
      'Backend Engineer',
      'Node.js and NestJS backend role building microservices and REST APIs. You will also maintain ' +
        'a small HubSpot integration for the sales team.',
    );
    expect(result.reject).toBe(false);
  });

  it('accepts a plain backend role with no marketing keywords at all', () => {
    const result = isMarketingEngineeringRole(
      'Backend Engineer',
      'Node.js and NestJS backend role building microservices and REST APIs with PostgreSQL.',
    );
    expect(result.reject).toBe(false);
  });
});
