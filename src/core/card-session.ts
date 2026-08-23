export type CardResponse = 'known' | 'unknown';

export interface CardItemInteraction {
  id: string;
  initialResponse: CardResponse | null;
  finalResponse: CardResponse | null;
  revealed: boolean;
  finalized: boolean;
}

export interface CardSessionState {
  orderedItemIds: string[];
  currentPosition: number;
  items: Record<string, CardItemInteraction>;
  lastFinalizedItemId: string | null;
}

function getCurrentInteraction(state: CardSessionState): CardItemInteraction {
  const itemId = state.orderedItemIds[state.currentPosition];
  if (!itemId) {
    throw new RangeError(
      `Card session has no item at position=${state.currentPosition}.`,
    );
  }
  const interaction = state.items[itemId];
  if (!interaction) {
    throw new Error(
      `Card session is missing interaction state for item=${itemId}.`,
    );
  }
  return interaction;
}

export function createCardSession(itemIds: string[]): CardSessionState {
  if (itemIds.length === 0) {
    throw new RangeError('Cannot create a card session without items.');
  }
  const uniqueIds = new Set(itemIds);
  if (uniqueIds.size !== itemIds.length) {
    throw new Error('Cannot create a card session with duplicate item IDs.');
  }
  const items: Record<string, CardItemInteraction> = {};
  for (const id of itemIds) {
    items[id] = {
      id,
      initialResponse: null,
      finalResponse: null,
      revealed: false,
      finalized: false,
    };
  }
  return {
    orderedItemIds: [...itemIds],
    currentPosition: 0,
    items,
    lastFinalizedItemId: null,
  };
}

export function answerCurrentCard(
  state: CardSessionState,
  response: CardResponse,
): CardSessionState {
  const interaction = getCurrentInteraction(state);
  if (interaction.finalized) {
    throw new Error(`Cannot answer finalized card item=${interaction.id}.`);
  }
  if (interaction.initialResponse !== null) {
    throw new Error(
      `Initial response already exists for card item=${interaction.id}.`,
    );
  }
  return {
    ...state,
    items: {
      ...state.items,
      [interaction.id]: {
        ...interaction,
        initialResponse: response,
        finalResponse: response,
        revealed: true,
      },
    },
  };
}

export function revealCurrentCard(state: CardSessionState): CardSessionState {
  const interaction = getCurrentInteraction(state);
  if (interaction.finalized) {
    throw new Error(`Cannot reveal finalized card item=${interaction.id}.`);
  }
  if (interaction.revealed) {
    throw new Error(`Card item is already revealed=${interaction.id}.`);
  }
  return {
    ...state,
    items: {
      ...state.items,
      [interaction.id]: { ...interaction, revealed: true },
    },
  };
}

export function correctCurrentCardResponse(
  state: CardSessionState,
  response: CardResponse,
): CardSessionState {
  const interaction = getCurrentInteraction(state);
  if (interaction.initialResponse === null || !interaction.revealed) {
    throw new Error(
      `Cannot correct an unrevealed card item=${interaction.id}.`,
    );
  }
  if (interaction.finalized) {
    throw new Error(`Cannot correct finalized card item=${interaction.id}.`);
  }
  return {
    ...state,
    items: {
      ...state.items,
      [interaction.id]: { ...interaction, finalResponse: response },
    },
  };
}

export function resetCurrentCard(state: CardSessionState): CardSessionState {
  const interaction = getCurrentInteraction(state);
  return {
    ...state,
    items: {
      ...state.items,
      [interaction.id]: {
        ...interaction,
        initialResponse: null,
        finalResponse: null,
        revealed: false,
        finalized: false,
      },
    },
  };
}

export function finalizeCurrentCard(state: CardSessionState): CardSessionState {
  const interaction = getCurrentInteraction(state);
  if (
    interaction.initialResponse === null ||
    interaction.finalResponse === null ||
    !interaction.revealed
  ) {
    throw new Error(`Cannot finalize incomplete card item=${interaction.id}.`);
  }
  if (interaction.finalized) {
    throw new Error(`Card item=${interaction.id} is already finalized.`);
  }
  return {
    ...state,
    currentPosition: state.currentPosition + 1,
    items: {
      ...state.items,
      [interaction.id]: { ...interaction, finalized: true },
    },
    lastFinalizedItemId: interaction.id,
  };
}

export function isCardSessionComplete(state: CardSessionState): boolean {
  return state.currentPosition >= state.orderedItemIds.length;
}

export function getFinalizedResponses(
  state: CardSessionState,
): Record<string, CardResponse> {
  const responses: Record<string, CardResponse> = {};
  for (const itemId of state.orderedItemIds) {
    const interaction = state.items[itemId];
    if (interaction?.finalized && interaction.finalResponse !== null) {
      responses[itemId] = interaction.finalResponse;
    }
  }
  return responses;
}
