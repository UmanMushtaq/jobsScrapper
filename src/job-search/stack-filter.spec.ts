import { isFrontendPrimaryStack } from './stack-filter';

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
