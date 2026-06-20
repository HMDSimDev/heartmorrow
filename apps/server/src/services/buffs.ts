/**
 * Buff helpers now live in @dsim/shared so the server and web client compute
 * effective stats identically. Re-exported here for existing server imports.
 */
export { effectiveDatingStats, listActiveBuffs, setTempBuff, decayBuffs, isBuffFlagKey } from '@dsim/shared';
