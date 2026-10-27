// Copy this file into an isolated github/gh-stack checkout's cmd directory.
// It deliberately uses that module's internal APIs; it is not a PwrAgent test.
package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/github/gh-stack/internal/config"
	"github.com/github/gh-stack/internal/github"
	"github.com/github/gh-stack/internal/modify"
	"github.com/github/gh-stack/internal/stack"
	"github.com/spf13/cobra"
)

func pwrBoundaryGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func pwrBoundaryWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func pwrBoundaryRun(t *testing.T, command *cobra.Command, args ...string) error {
	t.Helper()
	command.SetArgs(args)
	command.SilenceUsage = true
	command.SilenceErrors = true
	return command.Execute()
}

// No test runs in parallel: gh-stack's Git implementation uses the process cwd.
func TestPwrAgentStaleMergedBoundary(t *testing.T) {
	for _, recovery := range []bool{false, true} {
		t.Run(fmt.Sprintf("recovery=%v", recovery), func(t *testing.T) {
			root := t.TempDir()
			for _, key := range []string{
				"GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
				"GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
				"GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG",
				"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
			} {
				t.Setenv(key, "")
				if err := os.Unsetenv(key); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
			t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
			t.Setenv("GH_CONFIG_DIR", filepath.Join(root, "no-gh-credentials"))
			dir := filepath.Join(root, "work")
			remote := filepath.Join(root, "remote.git")
			pwrBoundaryGit(t, root, "init", "-q", "-b", "main", dir)
			pwrBoundaryGit(t, dir, "config", "user.name", "Fixture")
			pwrBoundaryGit(t, dir, "config", "user.email", "fixture@example.invalid")
			pwrBoundaryGit(t, dir, "config", "commit.gpgSign", "false")
			pwrBoundaryGit(t, dir, "config", "core.hooksPath", os.DevNull)
			pwrBoundaryGit(t, dir, "config", "rerere.enabled", "true")
			commit := func(name, content, subject string) string {
				pwrBoundaryWrite(t, filepath.Join(dir, name), content)
				pwrBoundaryGit(t, dir, "add", "--", name)
				pwrBoundaryGit(t, dir, "commit", "-q", "-m", subject)
				return pwrBoundaryGit(t, dir, "rev-parse", "HEAD")
			}
			old := commit("base.txt", "base\n", "old recorded base")
			pwrBoundaryGit(t, dir, "checkout", "-q", "-b", "parent")
			commit("parent.txt", "one\n", "parent one")
			parent := commit("parent.txt", "two\n", "parent two")
			pwrBoundaryGit(t, dir, "checkout", "-q", "-b", "child")
			commit("child.txt", "child\n", "child only")
			pwrBoundaryGit(t, dir, "checkout", "-q", "main")
			pwrBoundaryGit(t, dir, "merge", "--squash", "parent")
			pwrBoundaryGit(t, dir, "commit", "-q", "-m", "squash parent")
			squash := pwrBoundaryGit(t, dir, "rev-parse", "HEAD")
			integrated := commit("integration.txt", "integrated\n", "integrated base")
			pwrBoundaryGit(t, dir, "rebase", "--onto", "main", parent, "child")
			child := pwrBoundaryGit(t, dir, "rev-parse", "child")
			pwrBoundaryGit(t, root, "-c", "safe.bareRepository=all", "init", "-q", "--bare", "-b", "main", remote)
			pwrBoundaryGit(t, dir, "remote", "add", "origin", remote)
			pwrBoundaryGit(t, dir, "push", "-q", "-u", "origin", "main", "parent", "child")
			pwrBoundaryGit(t, dir, "checkout", "-q", "main")
			trunk := commit("parent.txt", "three\n", "new trunk changes parent content")
			pwrBoundaryGit(t, dir, "push", "-q", "origin", "main")
			pwrBoundaryGit(t, dir, "reset", "--hard", integrated)
			pwrBoundaryGit(t, dir, "checkout", "-q", "child")
			pwrBoundaryGit(t, dir, "worktree", "add", "-q", "-b", "unrelated", filepath.Join(root, "other"), old)
			remoteRefs := pwrBoundaryGit(t, dir, "ls-remote", "origin")

			tracked := stack.Stack{
				ID: "7", Number: 7,
				Trunk: stack.BranchRef{Branch: "main", Head: integrated},
				Branches: []stack.BranchRef{
					{Branch: "parent", Head: parent, Base: old, PullRequest: &stack.PullRequestRef{Number: 10, Merged: true}},
					{Branch: "child", Head: child, Base: old, PullRequest: &stack.PullRequestRef{Number: 11}},
				},
			}
			unrelated := stack.Stack{
				Trunk:    stack.BranchRef{Branch: "main", Head: old},
				Branches: []stack.BranchRef{{Branch: "unrelated", Head: old, Base: old}},
			}
			catalog, err := json.Marshal(map[string]any{"schemaVersion": 1, "stacks": []stack.Stack{tracked, unrelated}})
			if err != nil {
				t.Fatal(err)
			}
			pwrBoundaryWrite(t, filepath.Join(dir, ".git", "gh-stack"), string(catalog))
			beforeUnrelated, _ := json.Marshal(unrelated)
			cwd, err := os.Getwd()
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Chdir(dir); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Chdir(cwd) })
			cfg, outR, errR := config.NewTestConfig()
			_ = cfg.Out.Close()
			_ = cfg.Err.Close()
			_ = outR.Close()
			_ = errR.Close()
			log, err := os.Create(filepath.Join(root, "commands.log"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				_ = log.Close()
				if t.Failed() {
					data, _ := os.ReadFile(log.Name())
					if len(data) > 8000 {
						data = data[len(data)-8000:]
					}
					t.Logf("command log (bounded tail):\n%s", data)
				}
			})
			cfg.Out, cfg.Err = log, log
			cfg.RepoOverride = &repository.Repository{Owner: "fixture", Name: "fixture", Host: "github.com"}
			// Embed ClientOps so every unexpected call fails instead of silently
			// succeeding via MockClient's default implementation. All permitted
			// API calls below are reads; a mutation would call a nil interface.
			client := &pwrBoundaryReadClient{lookup: func(number int) *github.PullRequest {
				if number == 10 {
					return &github.PullRequest{Number: 10, HeadRefName: "parent", BaseRefName: "main", State: "MERGED", Merged: true}
				}
				if number == 11 {
					return &github.PullRequest{Number: 11, HeadRefName: "child", BaseRefName: "main", State: "OPEN", IsDraft: true}
				}
				return nil
			}}
			cfg.GitHubClientOverride = client
			stale := os.Getenv("PWRAGENT_EXPECT_STALE_BOUNDARY") == "1"
			boundary, err := resolveRebaseOldBase(parent, old, "main", "child")
			want := integrated
			if stale {
				want = old
			}
			if err != nil || boundary != want {
				t.Fatalf("boundary=%s, want=%s, err=%v", boundary, want, err)
			}
			t.Logf("recorded=%s squash=%s integrated=%s selected=%s", old, squash, integrated, boundary)
			if stale || !recovery {
				err = pwrBoundaryRun(t, RebaseCmd(cfg), "--upstack", "--remote", "origin")
				if stale {
					if err == nil || pwrBoundaryGit(t, dir, "show", "-s", "--format=%s", "REBASE_HEAD") != "squash parent" {
						t.Fatalf("expected squash replay conflict; err=%v", err)
					}
					if err := pwrBoundaryRun(t, RebaseCmd(cfg), "--abort"); err != nil {
						t.Fatal(err)
					}
					if pwrBoundaryGit(t, dir, "rev-parse", "child") != child {
						t.Fatal("abort changed child head")
					}
					if modify.CheckStackLinearity(cfg, &tracked) == nil {
						t.Fatal("expected modify's normalization guard to reject the divergent child")
					}
					t.Log("replayed squash parent; abort restored child")
				} else if err != nil {
					t.Fatal(err)
				}
			}
			if recovery {
				if err := pwrBoundaryRun(t, UnstackCmd(cfg), "--local"); err != nil {
					t.Fatal(err)
				}
				if err := pwrBoundaryRun(t, InitCmd(cfg), "--base", "main", "child"); err != nil {
					t.Fatal(err)
				}
				if pwrBoundaryGit(t, dir, "rev-parse", "child") != child {
					t.Fatal("local unstack/init changed child head")
				}
				if err := pwrBoundaryRun(t, RebaseCmd(cfg), "--upstack", "--remote", "origin"); err != nil {
					t.Fatal(err)
				}
			}
			if recovery || !stale {
				if pwrBoundaryGit(t, dir, "log", "--format=%s", "origin/main..child") != "child only" {
					t.Fatal("rebase did not preserve exactly the child commit")
				}
				if pwrBoundaryGit(t, dir, "show", "child:parent.txt") != "three" || pwrBoundaryGit(t, dir, "show", "child:child.txt") != "child" {
					t.Fatal("rebase lost trunk or child content")
				}
				pwrBoundaryGit(t, dir, "merge-base", "--is-ancestor", trunk, "child")
			}
			sf, err := stack.Load(filepath.Join(dir, ".git"))
			if err != nil {
				t.Fatal(err)
			}
			var afterUnrelated []byte
			childFound := false
			for _, s := range sf.Stacks {
				if s.IndexOf("unrelated") >= 0 {
					afterUnrelated, _ = json.Marshal(s)
				}
				if recovery && s.IndexOf("child") >= 0 && (len(s.Branches) != 1 || s.Branches[0].PullRequest == nil || s.Branches[0].PullRequest.Number != 11) {
					t.Fatal("recovery did not adopt only the existing child PR")
				}
				if i := s.IndexOf("child"); i >= 0 {
					childFound = true
					if (recovery || !stale) && s.Branches[i].Base != trunk {
						t.Fatal("child base metadata does not match the new trunk")
					}
				}
			}
			if !childFound || len(sf.Stacks) != 2 {
				t.Fatal("catalog did not retain exactly the affected and unrelated stacks")
			}
			if string(beforeUnrelated) != string(afterUnrelated) || pwrBoundaryGit(t, filepath.Join(root, "other"), "rev-parse", "HEAD") != old {
				t.Fatal("unrelated stack or linked worktree changed")
			}
			if pwrBoundaryGit(t, dir, "rev-parse", "parent") != parent || remoteRefs != pwrBoundaryGit(t, dir, "ls-remote", "origin") {
				t.Fatal("parent branch or remote refs changed")
			}
			if pwrBoundaryGit(t, dir, "status", "--porcelain") != "" {
				t.Fatal("fixture worktree is dirty")
			}
			if _, err := os.Stat(filepath.Join(dir, ".git", "gh-stack-rebase-state")); !os.IsNotExist(err) {
				t.Fatal("rebase journal remains")
			}
			t.Log("remote refs, PR settings, unrelated stack and linked worktree preserved; zero API mutations")
		})
	}
}

type pwrBoundaryReadClient struct {
	github.ClientOps
	lookup func(int) *github.PullRequest
}

func (c *pwrBoundaryReadClient) FindPRByNumber(number int) (*github.PullRequest, error) {
	return c.lookup(number), nil
}

func (c *pwrBoundaryReadClient) FindPRForBranch(branch string) (*github.PullRequest, error) {
	if branch == "child" {
		return c.lookup(11), nil
	}
	return nil, nil
}

func (c *pwrBoundaryReadClient) GetStack(number int) (*github.RemoteStack, error) {
	return &github.RemoteStack{ID: 7, Number: number, Base: github.RemoteStackBase{Ref: "main"}, PullRequests: []int{10, 11}}, nil
}

func (c *pwrBoundaryReadClient) ListStacks() ([]github.RemoteStack, error) {
	s, _ := c.GetStack(7)
	return []github.RemoteStack{*s}, nil
}
