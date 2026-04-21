/**
 * Separazione tra:
 * - **semantica del modello** (output del motore di probabilità sui mid BTC — trend / continuation),
 * - **semantica della strategia** (come quel numero entra nel confronto edge sul lato comprato).
 *
 * Il bot spike usa direzione **contrarian** in `evaluateEntryConditions`; il segnale `p_up` resta
 * **momentum-style** (vedi `binaryProbabilityEngine`). L’edge paper confronta il prezzo d’ask con
 * una **fair sul token comprato** derivata esplicitamente da questa mappa, non con `p_up` grezzo.
 */

/**
 * Short-horizon **continuation** P(BTC up) dal buffer mid (stesso significato di
 * `estimateProbabilityUpFromPriceBuffer` / campo `estimatedProbabilityUp` nei tick).
 * Non è la P(YES) del mercato Polymarket né la fair della strategia contrarian finché non mappata.
 */
export type MomentumProbabilityUp = number;

/**
 * Come trasformare `MomentumProbabilityUp` in P_model sul **token comprato** (YES o NO) per edge = P − ask.
 *
 * - `contrarian_mean_reversion`: fair sul lato comprato = complemento della view momentum **sullo stesso token**
 *   (coerente con fade dello spike: si compra il lato che il momentum short-term penalizza).
 * - `momentum_continuation`: fair sul lato = stessa semantica trend-following del modello (P(YES)=p_up, P(NO)=1−p_up).
 */
export type BinaryEdgeStrategySemantics =
  | "contrarian_mean_reversion"
  | "momentum_continuation";

/**
 * Converte la probabilità momentum P(up) nella fair P(buy leg) usata per edge e sizing,
 * in base alla semantica della strategia di edge (non alla sola direzione UP/DOWN del bot).
 */
export function fairBuyLegProbabilityFromMomentumUp(
  momentumProbabilityUp: number,
  strategyBuySide: "YES" | "NO",
  edgeStrategy: BinaryEdgeStrategySemantics
): number {
  const pUp = momentumProbabilityUp;
  if (edgeStrategy === "momentum_continuation") {
    return strategyBuySide === "YES" ? pUp : 1 - pUp;
  }
  return strategyBuySide === "YES" ? 1 - pUp : pUp;
}
