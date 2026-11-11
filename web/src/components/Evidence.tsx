import { LiveLayer } from "./LiveEvidence";
import type { Instrument, LayerId } from "../engine/types";
import { LAYER_LABEL } from "../engine/universe";
import { LAYER_QUESTION, layerTone } from "../engine/evidence";
import { MINUS } from "../engine/format";

/** One layer's score + its live evidence (real data from the market API, or an honest N/A). */
export function LayerEvidence({ inst, layer }: { inst: Instrument; layer: LayerId }) {
  const score = inst.signal.layers[layer];
  const tone = layerTone(score);
  return (
    <div className="ev">
      <header className="ev__head">
        <div>
          <p className="eyebrow">{LAYER_LABEL[layer]}</p>
          <p className="ev__q serif">{LAYER_QUESTION[layer]}</p>
        </div>
        <div className={`ev__score ev__score--${tone.cls}`}>
          <span className="ev__score-num mono">
            {score === null ? "N/A" : score > 0 ? `+${score}` : score < 0 ? `${MINUS}${Math.abs(score)}` : "0"}
          </span>
          <span className="ev__score-lab">{tone.label}</span>
          {score !== null && (
            <span className="ev__score-bar" aria-hidden="true">
              <i style={{ left: score >= 0 ? "50%" : `${50 + score / 2}%`, width: `${Math.abs(score) / 2}%` }} />
            </span>
          )}
        </div>
      </header>
      <LiveLayer inst={inst} layer={layer} />
    </div>
  );
}
