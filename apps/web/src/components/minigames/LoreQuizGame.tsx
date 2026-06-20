import { useRef, useState } from 'react';
import type { Character, LoreQuizConfig, LoreQuizSubmission } from '@dsim/shared';
import { Portrait } from '../Portrait';
import { MinigameShell } from './MinigameShell';

export function LoreQuizGame({
  config,
  partner,
  onComplete,
}: {
  config: LoreQuizConfig;
  partner?: Pick<Character, 'name' | 'portraitAssetId' | 'expressionAssets'>;
  onComplete: (submission: LoreQuizSubmission) => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Array<{ questionId: string; choiceIndex: number }>>([]);
  const doneRef = useRef(false);

  const question = config.questions[index];
  if (!question) return null;

  const choose = (choiceIndex: number) => {
    if (doneRef.current) return;
    const next = [...answers, { questionId: question.id, choiceIndex }];
    setAnswers(next);
    if (index + 1 >= config.questions.length) {
      doneRef.current = true;
      onComplete({ answers: next });
    } else {
      setIndex(index + 1);
    }
  };

  return (
    <MinigameShell
      title="Lore Quiz"
      progress={{ current: index + 1, total: config.questions.length }}
    >
      <div className="mg-board mga-board">
        {partner && (
          <div className="lq-partner-frame">
            <span className="lq-portrait">
              <Portrait character={partner} />
            </span>
            <p className="lq-lead">
              {partner.name} leans in, eyes glinting. "Let's see how well you know me…"
            </p>
          </div>
        )}
        <h3 className="mga-question">{question.prompt}</h3>
        <div className="stack">
          {question.choices.map((choice, i) => (
            <button
              key={i}
              className="btn quiz-choice mga-quiz-choice"
              data-key={String.fromCharCode(65 + i)}
              onClick={() => choose(i)}
            >
              {choice}
            </button>
          ))}
        </div>
      </div>
    </MinigameShell>
  );
}
