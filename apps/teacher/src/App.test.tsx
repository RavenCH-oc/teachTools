import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("Teacher application shell", () => {
  it("renders the Phase 1 teacher surface", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Classroom" })).toBeInTheDocument();
    expect(screen.getByText("Phase 1 application skeleton is running.")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Teacher navigation" })).toBeInTheDocument();
  });
});
