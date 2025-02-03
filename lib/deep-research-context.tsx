"use client";

import { createContext, useContext, useReducer, ReactNode, useCallback } from 'react';

interface ActivityItem {
  type: 'search' | 'extract' | 'analyze';
  status: 'pending' | 'complete' | 'error';
  message: string;
  timestamp: string;
}

interface SourceItem {
  url: string;
  title: string;
  relevance: number;
}

interface DeepResearchState {
  isActive: boolean;
  activity: ActivityItem[];
  sources: SourceItem[];
}

type DeepResearchAction = 
  | { type: 'TOGGLE_ACTIVE' }
  | { type: 'SET_ACTIVE'; payload: boolean }
  | { type: 'ADD_ACTIVITY'; payload: ActivityItem }
  | { type: 'ADD_SOURCE'; payload: SourceItem }
  | { type: 'CLEAR_STATE' };

interface DeepResearchContextType {
  state: DeepResearchState;
  toggleActive: () => void;
  setActive: (active: boolean) => void;
  addActivity: (activity: ActivityItem) => void;
  addSource: (source: SourceItem) => void;
  clearState: () => void;
}

const initialState: DeepResearchState = {
  isActive: true,
  activity: [],
  sources: [],
};

function deepResearchReducer(state: DeepResearchState, action: DeepResearchAction): DeepResearchState {
  switch (action.type) {
    case 'TOGGLE_ACTIVE':
      return {
        ...state,
        isActive: !state.isActive,
        ...(state.isActive && { activity: [], sources: [] }), // Clear state when toggling off
      };
    case 'SET_ACTIVE':
      return {
        ...state,
        isActive: action.payload,
        ...(action.payload === false && { activity: [], sources: [] }), // Clear state when setting to false
      };
    case 'ADD_ACTIVITY':
      return {
        ...state,
        activity: [...state.activity, action.payload],
      };
    case 'ADD_SOURCE':
      return {
        ...state,
        sources: [...state.sources, action.payload],
      };
    case 'CLEAR_STATE':
      return {
        ...state,
        activity: [],
        sources: [],
      };
    default:
      return state;
  }
}

const DeepResearchContext = createContext<DeepResearchContextType | undefined>(undefined);

export function DeepResearchProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(deepResearchReducer, initialState);

  const toggleActive = useCallback(() => {
    dispatch({ type: 'TOGGLE_ACTIVE' });
  }, []);

  const setActive = useCallback((active: boolean) => {
    dispatch({ type: 'SET_ACTIVE', payload: active });
  }, []);

  const addActivity = useCallback((activity: ActivityItem) => {
    dispatch({ type: 'ADD_ACTIVITY', payload: activity });
  }, []);

  const addSource = useCallback((source: SourceItem) => {
    dispatch({ type: 'ADD_SOURCE', payload: source });
  }, []);

  const clearState = useCallback(() => {
    dispatch({ type: 'CLEAR_STATE' });
  }, []);

  return (
    <DeepResearchContext.Provider
      value={{
        state,
        toggleActive,
        setActive,
        addActivity,
        addSource,
        clearState,
      }}
    >
      {children}
    </DeepResearchContext.Provider>
  );
}

export function useDeepResearch() {
  const context = useContext(DeepResearchContext);
  if (context === undefined) {
    throw new Error('useDeepResearch must be used within a DeepResearchProvider');
  }
  return context;
} 