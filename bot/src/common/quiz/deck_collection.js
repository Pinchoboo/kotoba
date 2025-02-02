
const assert = require('assert');

const cardStrategies = require('./card_strategies.js');
const deckLoader = require('./deck_loader.js');
const shuffleArray = require('./../util/array.js').shuffle;
const MAX_APPEARANCE_WEIGHT = require('kotoba-common').quizLimits.appearanceWeight[1];

const NUM_OPTIONS_FOR_MC = 5;

function deepCopy(object) {
  return JSON.parse(JSON.stringify(object));
}

function createIndexSetForDecks(decks, shuffle) {
  const indexSet = [];
  decks.forEach((deck) => {
    const startIndex = deck.startIndex || 1;
    const endIndex = deck.endIndex || deck.cards.length;
    const indices = Array((endIndex - startIndex) + 1);
    for (let i = startIndex; i <= endIndex; i += 1) {
      indices[i - startIndex] = i - 1;
    }

    indexSet.push(shuffle ? shuffleArray(indices) : indices.reverse());
  });

  return indexSet;
}

function countCards(indexSet) {
  return indexSet.reduce((sum, indices) => sum + indices.length, 0);
}

function createDeckSettings(decks) {
  return decks.map((deck) => ({
    appearanceWeight: deck.appearanceWeight ?? (MAX_APPEARANCE_WEIGHT / decks.length),
  }));
}

function shuffleOptions(card) {
  if (!card.options || !(card.answer[0] >= '1' && card.answer[0] <= '5')) {
    return card;
  }

  const shuffledOptions = shuffleArray(card.options);
  const correctOptionIndex = shuffledOptions.indexOf(card.answer[1]);
  if (correctOptionIndex === -1) {
    return card;
  }

  card.options = shuffledOptions;
  card.answer[0] = (correctOptionIndex + 1).toString();

  return card;
}

class DeckCollection {
  constructor() {
    this.discardedCards = [];
  }

  static createNewFromDecks(decks, gameMode, shuffle) {
    const deckCollection = new DeckCollection();
    deckCollection.nextCardId = 0;
    deckCollection.decks = decks;
    deckCollection.indexSet = createIndexSetForDecks(decks, shuffle);
    deckCollection.initialCardCount = countCards(deckCollection.indexSet);
    const deckName = deckCollection.decks[0].name;
    if (deckCollection.decks.every(deck => deck.name === deckName)) {
      deckCollection.name = deckName;
      deckCollection.description = decks[0].description;
    } else {
      deckCollection.name = 'Multiple Deck Quiz';
    }

    deckCollection.name = gameMode.overrideDeckTitle(deckCollection.name);

    deckCollection.previousCardCache = [];
    for (let i = 0; i < decks.length; i += 1) {
      deckCollection.previousCardCache.push({});
    }

    return deckCollection;
  }

  static async createFromSaveData(saveData) {
    const deckQueries = saveData.deckUniqueIds.map((uniqueId, index) => {
      const mc = saveData.numberOfOptionsForDeck && !!saveData.numberOfOptionsForDeck[index];
      return { deckNameOrUniqueId: uniqueId, mc };
    });

    const deckLookupStatus = await deckLoader.getQuizDecks(deckQueries);
    if (deckLookupStatus.notFoundDeckName) {
      const error = new Error('Deck not found');
      error.code = 'DECK_NOT_FOUND';
      throw error;
    }

    const deckCollection = new DeckCollection();
    deckCollection.decks = deckLookupStatus.decks;
    deckCollection.initialCardCount = saveData.initialCardCount;
    assert(deckCollection.decks, 'couldn\'t find a save deck by unique ID');
    deckCollection.indexSet = saveData.indexSet;
    deckCollection.name = saveData.name;
    deckCollection.nextCardId = saveData.nextCardId;
    deckCollection.previousCardCache = saveData.previousCardCache;

    const deckSettings = saveData.deckSettings ?? createDeckSettings(deckCollection.decks);

    for (let i = 0; i < deckSettings.length; ++i) {
      Object.assign(deckCollection.decks[i], deckSettings[i]);
    }

    return deckCollection;
  }

  getRemainingCardCount() {
    return countCards(this.indexSet);
  }

  calculateProgress() {
    if (!this.initialCardCount) {
      return undefined;
    }

    const remainingCards = countCards(this.indexSet);
    const cardsCompleted = this.initialCardCount - remainingCards;
    return cardsCompleted / this.initialCardCount;
  }

  requiresAudioConnection() {
    return this.decks.some(deck => deck.requiresAudioConnection);
  }

  containsInternetCards() {
    return this.decks.some(deck => deck.isInternetDeck);
  }

  getPreviousShownCards() {
    const cachedCards = [];
    this.previousCardCache.forEach((cachedDeck) => {
      Object.values(cachedDeck).forEach((cachedCard) => {
        cachedCards.push(cachedCard);
      });
    });
    return cachedCards.concat(this.discardedCards);
  }

  isEmpty() {
    for (let i = 0; i < this.indexSet.length; i += 1) {
      const array = this.indexSet[i];
      if (array.length > 0) {
        return false;
      }
    }
    return true;
  }

  getAllUndisplayedCards() {
    const undisplayedCards = [];
    for (let deckIndex = 0; deckIndex < this.indexSet.length; deckIndex += 1) {
      const deck = this.decks[deckIndex];
      const unseenCardIndices = this.indexSet[deckIndex];

      if (!deck.cards.memoryArray) {
        throw new Error('Trying to get all undisplayed cards from a non-memory deck. That\'s too expensive!');
      }

      unseenCardIndices.forEach((cardIndex) => {
        undisplayedCards.push(deck.cards.memoryArray[cardIndex]);
      });
    }

    return undisplayedCards;
  }

  async popUndisplayedCard(settings, gameMode) {
    if (this.isEmpty()) {
      return undefined;
    }

    const decksWithCardsLeft = this.indexSet.map((cardIndexes, index) => ({
      cardIndexes,
      deck: this.decks[index],
      index,
    })).filter(deck => deck.cardIndexes.length > 0);

    const randomFactor = Math.random() * MAX_APPEARANCE_WEIGHT;
    let remainingRandomFactor = randomFactor;

    const deckToUse = decksWithCardsLeft.find((deck) => {
      if (remainingRandomFactor <= deck.deck.appearanceWeight) {
        return true;
      }

      remainingRandomFactor -= deck.deck.appearanceWeight;
    }) ?? decksWithCardsLeft[decksWithCardsLeft.length - 1];

    const deckIndex = deckToUse.index;
    const cardIndex = deckToUse.cardIndexes.pop();
    const deck = deckToUse.deck;

    // Calculate progress before popping the next card
    // so that that card is not counted as complete.
    const progress = this.calculateProgress();

    let card = this.previousCardCache[deckIndex][cardIndex];
    if (!card) {
      if (cardIndex >= deck.cards.length) {
        return this.popUndisplayedCard(settings, gameMode);
      }

      const deckCard = await deck.cards.get(cardIndex);
      if (!deckCard) {
        return this.popUndisplayedCard(settings, gameMode);
      }
      card = deepCopy(deckCard);
    }

    if (gameMode.isMasteryMode) {
      card.deckProgress = progress;
    }

    this.previousCardCache[deckIndex][cardIndex] = card;

    if (!Array.isArray(card.answer)) {
      card.answer = [card.answer];
    }

    card.deckName = card.deckName || deck.name;
    card.deckId = card.deckId || deck.uniqueId;
    card.instructions = card.instructions || deck.instructions || '';
    card.dictionaryLinkStrategy = card.dictionaryLinkStrategy || deck.dictionaryLinkStrategy;
    card.questionCreationStrategy = card.questionCreationStrategy || deck.questionCreationStrategy;
    card.preprocessingStrategy = card.preprocessingStrategy || deck.cardPreprocessingStrategy;
    card.answerTimeLimitStrategy = card.answerTimeLimitStrategy || deck.answerTimeLimitStrategy;
    card.requiresAudioConnection = card.requiresAudioConnection || deck.requiresAudioConnection;
    card.fontSize = settings.fontSize;
    card.fontColor = settings.fontColor;
    card.backgroundColor = settings.backgroundColor;
    card.font = settings.font;

    card.discordFinalAnswerListElementStrategy =
      card.discordFinalAnswerListElementStrategy || deck.discordFinalAnswerListElementStrategy;

    card.discordIntermediateAnswerListElementStrategy =
      card.discordIntermediateAnswerListElementStrategy
      || deck.discordIntermediateAnswerListElementStrategy;

    card.scoreAnswerStrategy = card.scoreAnswerStrategy || deck.scoreAnswerStrategy;

    card.additionalAnswerWaitStrategy =
      card.additionalAnswerWaitStrategy || deck.additionalAnswerWaitStrategy;

    card.answerCompareStrategy = card.answerCompareStrategy || deck.answerCompareStrategy;
    card.mc = card.mc || deck.mc;
    card.commentFieldName = card.commentFieldName || deck.commentFieldName;
    card.answerHistory = card.answerHistory || [];
    card.cardIndex = cardIndex;
    card.deckIndex = deckIndex;
    card.mostRecentAppearanceAnswerers = [];
    if (card.isInternetCard === undefined) {
      card.isInternetCard = deck.isInternetDeck;
    }
    if (card.id === undefined) {
      card.id = this.nextCardId + 1;
      this.nextCardId += 1;
    }
    if (card.dictionaryLink === undefined) {
      card.dictionaryLink =
        cardStrategies.CreateDictionaryLinkStrategy[deck.dictionaryLinkStrategy](card);
    }
    if (card.unansweredQuestionLimit === undefined) {
      card.unansweredQuestionLimit = settings.unansweredQuestionLimit;
    }
    if (card.answerTimeLimitInMs === undefined) {
      card.answerTimeLimitInMs =
        cardStrategies.AnswerTimeLimitStrategy[card.answerTimeLimitStrategy](settings, card);
    }
    if (card.additionalAnswerWaitTimeInMs === undefined) {
      card.additionalAnswerWaitTimeInMs =
        cardStrategies.AdditionalAnswerWaitStrategy[card.additionalAnswerWaitStrategy](settings);
    }
    if (card.newQuestionDelayAfterAnsweredInMs === undefined) {
      card.newQuestionDelayAfterAnsweredInMs = settings.newQuestionDelayAfterAnsweredInMs;
    }
    if (card.newQuestionDelayAfterUnansweredInMs === undefined) {
      card.newQuestionDelayAfterUnansweredInMs = settings.newQuestionDelayAfterUnansweredInMs;
    }
    if (card.numberOfReveals === undefined) {
      card.numberOfReveals = cardStrategies.RevealsLeftStrategy[card.answerTimeLimitStrategy]();
    }
    if (card.compareAnswer === undefined) {
      card.compareAnswer = cardStrategies.AnswerCompareStrategy[card.answerCompareStrategy];
    }
    if (card.effect === undefined) {
      card.effect = settings.effect;
    }
    card.createQuestion = cardStrategies.CreateQuestionStrategy[card.questionCreationStrategy];
    card.preprocess = cardStrategies.CardPreprocessingStrategy[card.preprocessingStrategy];
    card.scoreAnswer = cardStrategies.ScoreAnswerStrategy[card.scoreAnswerStrategy];

    const { mc } = card;
    shuffleOptions(card);

    if (!mc || card.options) {
      return card;
    }

    const correctAnswer = card.answer[0];
    const options = [correctAnswer];

    let loopCounter = 0;
    const numberOfOptions = NUM_OPTIONS_FOR_MC;
    while (options.length < numberOfOptions && options.length < this.decks[0].cards.length) {
      const randomDeckIndex = Math.floor(Math.random() * this.decks.length);
      const randomDeck = this.decks[randomDeckIndex];
      const randomCardIndex = Math.floor(Math.random() * randomDeck.cards.length);

      // This could probably be refactored to be at least a
      // little more parallel. For now, disable the rule.
      // eslint-disable-next-line no-await-in-loop
      const randomCard = await randomDeck.cards.get(randomCardIndex);

      if (randomCard) {
        const randomAnswer = randomCard.answer[0];
        if (options.indexOf(randomAnswer) === -1) {
          options.push(randomAnswer);
        }
      }

      loopCounter += 1;
      if (loopCounter > 10000) {
        break;
      }
    }

    card.options = shuffleArray(options);
    const correctOptionIndex = card.options.indexOf(correctAnswer);
    assert(correctOptionIndex !== -1, 'No correct option?');

    const correctOptionCharacter = `${correctOptionIndex + 1}`;
    card.answer.unshift(correctOptionCharacter);

    return card;
  }

  createSaveData() {
    return {
      deckUniqueIds: this.decks.map(deck => deck.uniqueId),
      numberOfOptionsForDeck: this.decks.map(deck => deck.mc),
      indexSet: this.indexSet,
      name: this.getName(),
      description: this.getDescription(),
      nextCardId: this.nextCardId,
      previousCardCache: this.previousCardCache,
      initialCardCount: this.initialCardCount,
      deckSettings: createDeckSettings(this.decks),
    };
  }

  getName() {
    return this.name;
  }

  getDescription() {
    return this.description;
  }

  getDeckId() {
    if (this.decks.length === 1) {
      return this.decks[0].uniqueId;
    }
    return -1;
  }

  recycleCard(card, gameMode, settings) {
    const recycled = gameMode.recycleCard(card, this.indexSet[card.deckIndex], this.decks.length, settings);
    if (!recycled) {
      // The previous card cache gets saved to disk if the user saves.
      // But we don't want to save all previously seen cards, that would
      // take a lot of space. We only need to save the ones that the user
      // will see again. So if the card gets discarded, put it into
      // a different data structure.
      delete this.previousCardCache[card.deckIndex][card.cardIndex];
      this.discardedCards.push(card);
    }
  }
}

module.exports = DeckCollection;
