package cgroup

import "testing"

func TestParseMemory(t *testing.T) {
	cases := map[string]int64{
		"512m":    512 << 20,
		"2g":      2 << 30,
		"1024k":   1024 << 10,
		"1048576": 1048576,
	}
	for input, want := range cases {
		got, err := ParseMemory(input)
		if err != nil || got != want {
			t.Errorf("ParseMemory(%q) = %d, %v; want %d", input, got, err, want)
		}
	}
	for _, bad := range []string{"", "abc", "-1g", "0"} {
		if _, err := ParseMemory(bad); err == nil {
			t.Errorf("ParseMemory(%q) should error", bad)
		}
	}
}
