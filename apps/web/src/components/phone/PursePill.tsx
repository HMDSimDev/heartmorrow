/** The one cash readout for the money apps. It lives in the PhoneAppBar's right
 *  slot so Market, Property and the Casino all report your purse in the same
 *  place, in the same type — before this each app invented its own (a wide strip,
 *  a coin-iconed capsule, bare mono text) and switching between them felt like
 *  switching phones. */
export function PursePill({ money }: { money: number }) {
  return (
    <span className="purse">
      <span className="purse-n">◈ {Math.round(money).toLocaleString()}</span>
    </span>
  );
}
