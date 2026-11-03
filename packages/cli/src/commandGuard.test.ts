import { describe, expect, it } from 'vitest';
import { unknownCommand, unknownCommandMessage } from './commandGuard.js';

/**
 * CLAIM-TYPO-NEVER-STARTS. `start` is the default command, so an unrecognised
 * first word used to be handed to it: with options that gave a misleading
 * "unknown option" (reported on a real machine for `solix gate --rules …`
 * against a release without `gate`), and without options a typo like
 * `solix gaet` started the server and wired ~/.claude. The guard runs before
 * commander routes anything.
 */
const KNOWN = ['start', 'install', 'uninstall', 'run', 'gate', 'doctor', 'level', 'rules', 'ledger', 'report', 'demo'];
const argv = (...rest: string[]) => ['node', 'solix', ...rest];

describe('CLAIM-TYPO-NEVER-STARTS · unknown first word', () => {
  it('lets real commands, help, flags, and a bare `solix` through', () => {
    expect(unknownCommand(argv(), KNOWN)).toBeNull();
    expect(unknownCommand(argv('start', '--port', '4300'), KNOWN)).toBeNull();
    expect(unknownCommand(argv('gate', '--rules', 'defaults', '--', 'claude'), KNOWN)).toBeNull();
    expect(unknownCommand(argv('help'), KNOWN)).toBeNull();
    expect(unknownCommand(argv('--port', '4300'), KNOWN)).toBeNull();
    expect(unknownCommand(argv('--version'), KNOWN)).toBeNull();
  });

  it('refuses a typo and suggests the command it was meant to be', () => {
    expect(unknownCommand(argv('gaet'), KNOWN)).toEqual({ name: 'gaet', suggestion: 'gate' });
    expect(unknownCommand(argv('doctr'), KNOWN)).toEqual({ name: 'doctr', suggestion: 'doctor' });
  });

  it('refuses a command this version does not have — the reported case — instead of misrouting it', () => {
    const withoutGate = KNOWN.filter((k) => k !== 'gate');
    const u = unknownCommand(argv('gate', '--rules', 'defaults'), withoutGate);
    expect(u?.name).toBe('gate');
    expect(unknownCommandMessage(u!, '1.18.3')).toMatch(/unknown command 'gate'[\s\S]*solix 1\.18\.3[\s\S]*newer release/);
  });

  it('does not invent a suggestion for something nowhere near a command', () => {
    expect(unknownCommand(argv('nosuchcmd'), KNOWN)).toEqual({ name: 'nosuchcmd' });
    expect(unknownCommand(argv('x'), KNOWN)).toEqual({ name: 'x' });
  });
});
