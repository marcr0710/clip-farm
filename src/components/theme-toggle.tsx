import { MoonStar, SunMedium } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ThemeToggleProps {
  theme: "light" | "dark";
  onToggle: () => void;
}

export function ThemeToggle({ theme, onToggle }: ThemeToggleProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      onClick={onToggle}
      className="rounded-full border-border/70 bg-background/80 backdrop-blur transition-all hover:-translate-y-0.5 hover:bg-accent"
      aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
    >
      {theme === "light" ? <MoonStar className="size-4" /> : <SunMedium className="size-4" />}
    </Button>
  );
}
