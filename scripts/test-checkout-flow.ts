/**
 * @deprecated Usar: npm run test:checkout-flow
 */
import { execSync } from 'node:child_process';

execSync('npm run test:checkout-flow', { stdio: 'inherit' });
