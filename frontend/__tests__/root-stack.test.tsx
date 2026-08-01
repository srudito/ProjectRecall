import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { Stack } from "expo-router";

import {
  AUTHENTICATED_ROOT_ROUTES,
  PUBLIC_ROOT_ROUTES,
  resolveRootAuthState,
} from "@/src/services/auth/route-access";
import { RootNavigator } from "@/src/navigation/RootStack";

jest.mock("expo-router", () => {
  const MockStack = Object.assign(
    function MockStack() {
      return null;
    },
    {
      Screen: function MockStackScreen() {
        return null;
      },
      Protected: function MockStackProtected() {
        return null;
      },
    },
  );

  return { Stack: MockStack };
});

type TestElement = ReactElement<{
  children?: ReactNode;
  guard?: boolean;
  name?: string;
  options?: { presentation?: string };
}>;

function elementsFrom(children: ReactNode): TestElement[] {
  return Children.toArray(children).filter(isValidElement) as TestElement[];
}

function findProtectedElement(root: TestElement): TestElement {
  const protectedElement = elementsFrom(root.props.children).find(
    (element) => element.type === Stack.Protected,
  );

  if (!protectedElement) {
    throw new Error("Expected a Stack.Protected element");
  }

  return protectedElement;
}

function screenNames(children: ReactNode): string[] {
  return elementsFrom(children)
    .filter((element) => element.type === Stack.Screen)
    .map((element) => element.props.name)
    .filter((name): name is string => Boolean(name));
}

describe("root authentication navigation", () => {
  it("waits for persisted auth restoration before deciding route access", () => {
    expect(
      resolveRootAuthState({ initialized: false, hasSession: false }),
    ).toBe("loading");
    expect(
      resolveRootAuthState({ initialized: false, hasSession: true }),
    ).toBe("loading");
  });

  it("recognizes signed-out and restored authenticated sessions", () => {
    expect(
      resolveRootAuthState({ initialized: true, hasSession: false }),
    ).toBe("unauthenticated");
    expect(
      resolveRootAuthState({ initialized: true, hasSession: true }),
    ).toBe("authenticated");
  });

  it("protects every documented authenticated root route", () => {
    expect(AUTHENTICATED_ROOT_ROUTES).toEqual([
      "(onboarding)",
      "(tabs)",
      "record/setup",
      "record/active",
      "record/review",
      "session/[id]",
      "project/[id]",
    ]);
    const root = RootNavigator({
      isAuthenticated: false,
    }) as TestElement;
    const protectedElement = findProtectedElement(root);

    expect(protectedElement.props.guard).toBe(false);
    expect(screenNames(protectedElement.props.children)).toEqual(
      AUTHENTICATED_ROOT_ROUTES,
    );
  });

  it("keeps only the intended root routes public", () => {
    expect(PUBLIC_ROOT_ROUTES).toEqual([
      "index",
      "(auth)",
      "auth/callback",
      "auth/reset",
    ]);
    const root = RootNavigator({
      isAuthenticated: false,
    }) as TestElement;
    const protectedElement = findProtectedElement(root);
    const protectedNames = screenNames(protectedElement.props.children);

    expect(screenNames(root.props.children)).toEqual(PUBLIC_ROOT_ROUTES);
    expect(protectedNames).not.toContain("auth/callback");
    expect(protectedNames).not.toContain("auth/reset");
  });

  it("enables protected routes for an authenticated session", () => {
    const root = RootNavigator({
      isAuthenticated: true,
    }) as TestElement;

    expect(findProtectedElement(root).props.guard).toBe(true);
  });

  it("preserves the record setup modal presentation", () => {
    const root = RootNavigator({
      isAuthenticated: true,
    }) as TestElement;
    const protectedElement = findProtectedElement(root);
    const setupScreen = elementsFrom(protectedElement.props.children).find(
      (element) => element.props.name === "record/setup",
    );

    expect(setupScreen?.props.options).toEqual({
      presentation: "modal",
    });
  });

  it("declares every root route exactly once", () => {
    const allRoutes = [
      ...PUBLIC_ROOT_ROUTES,
      ...AUTHENTICATED_ROOT_ROUTES,
    ];

    expect(new Set(allRoutes).size).toBe(allRoutes.length);
  });
});
