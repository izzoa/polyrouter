/**
 * Public surface of the Layer-1 structural routing engine (#13, spec §7.2).
 * Pure feature extraction + classification; the control-plane `StructuralRouter`
 * supplies the learned baseline and maps the band to a configured tier target.
 */
export * from './features';
export * from './classify';
