/** Diamond energy gauge shared by the global HUD and the Dashboard. Caps the
 *  rendered pip count so a large stamina max can't blow out the layout. */
export function EnergyPips({ value, max, cap = 12 }: { value: number; max: number; cap?: number }) {
  const total = Math.max(max, value, 0);
  if (total > cap) {
    return (
      <span className="epips epips-count" aria-label={`${value} of ${max} energy`}>
        <span className="epip on" />
        <span className="epips-n">
          {value}/{max}
        </span>
      </span>
    );
  }
  return (
    <span className="epips" aria-label={`${value} of ${max} energy`}>
      {Array.from({ length: total }).map((_, i) => (
        <span key={i} className={`epip${i < value ? ' on' : ''}`} />
      ))}
    </span>
  );
}
