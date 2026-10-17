@id:role-access
Feature: Role access
  A role gives its users some instances, with a maximum level for each group and operation.
  A user can narrow those levels further for their own agents.
  An agent of a user gets the tightest level of the instance, the role and the user.

  Background:
    Given the instance "tasks" has the list "Groceries" with the open tasks "milk", "bread" and "eggs"
    And user 12 has the role "family", which has the instance "tasks"
    And the role "family" lets its users set their own levels on "tasks"
    And agent 9 belongs to user 12 and may read and write

  Rule: A role maximum caps the instance level

    Scenario: A role maximum ask makes a write at level write ask
      Given the admin sets the group "tasks" of "tasks" to write
      And the admin sets the maximum of "family" for the group "tasks" to ask
      When agent 9 adds "butter" to "Groceries"
      Then agent 9 is told that the call waits for a human to approve it

    Scenario: A role maximum write does not open a write at level ask
      Given the admin sets the group "tasks" of "tasks" to ask
      And the admin sets the maximum of "family" for the group "tasks" to write
      When agent 9 adds "butter" to "Groceries"
      Then agent 9 is told that the call waits for a human to approve it

    Scenario: A role maximum read closes the writes of the group
      Given the admin sets the group "tasks" of "tasks" to write
      And the admin sets the maximum of "family" for the group "tasks" to read
      When agent 9 adds "butter" to "Groceries"
      Then agent 9 is told that the admin turned the operation off

  Rule: A missing role layer keeps the operation closed

    Scenario: A group with no role maximum is off for the role
      Given the admin sets the group "tasks" of "tasks" to write
      And the role "family" has no maximum for the group "tasks"
      When agent 9 adds "butter" to "Groceries"
      Then agent 9 is told that the admin turned the operation off

    Scenario: An instance outside the role is not available to its users
      Given the admin takes the instance "tasks" out of the role "family"
      When agent 9 asks for the open tasks of "Groceries"
      Then agent 9 is told that "tasks" is not available to its role

    Scenario: A role maximum for one operation wins over the maximum of its group
      Given the admin sets the group "tasks" of "tasks" to write
      And the admin sets the maximum of "family" for the group "tasks" to read
      And the admin sets the maximum of "family" for "complete a task" to write
      When agent 9 completes "milk" in "Groceries"
      Then the list "Groceries" holds only the open tasks "bread" and "eggs"

  Rule: A personal level narrows the role maximum

    Scenario: A personal level ask makes a read ask
      Given the admin sets the maximum of "family" for the group "lists" to read
      And user 12 sets their own level of "show the open tasks" to ask
      When agent 9 asks for the open tasks of "Groceries"
      Then agent 9 is told that the call waits for a human to approve it

    Scenario: A user cannot set a personal level above the role maximum
      Given the admin sets the group "tasks" of "tasks" to write
      And the admin sets the maximum of "family" for the group "tasks" to ask
      When user 12 tries to set their own level of "add a task" to write
      Then user 12 is told that their role allows at most ask for "add a task"

    Scenario: A lower role maximum wins over a personal level
      Given the admin sets the maximum of "family" for the group "tasks" to write
      And user 12 sets their own level of "add a task" to ask
      And the admin sets the maximum of "family" for the group "tasks" to read
      When agent 9 adds "butter" to "Groceries"
      Then agent 9 is told that the admin turned the operation off

  Rule: Locked operations, the credential ceiling and the owner apply on top of the role

    Scenario: A locked operation opens for a user when every layer gives it ask
      Given the admin gives "delete a list" its own level ask
      And the admin sets the maximum of "family" for "delete a list" to ask
      When agent 9 deletes the list "Groceries"
      Then agent 9 is told that the call waits for a human to approve it

    Scenario: A read-only credential of a user cannot write at role maximum write
      Given the admin sets the group "tasks" of "tasks" to write
      And the admin sets the maximum of "family" for the group "tasks" to write
      And user 12 gave agent 9 a read-only credential instead
      When agent 9 adds "butter" to "Groceries"
      Then agent 9 is told that its credential has read-only access

    Scenario: The agent of a disabled user is refused
      Given agent 9 has an open session on "tasks"
      And the admin disables user 12
      When agent 9 asks again for the open tasks of "Groceries" in the same session
      Then agent 9 is refused, and gets no tasks
