@id:access-levels
Feature: Access levels
  An admin decides how far each agent can go with each group of operations.
  An operation can also have its own level, which wins over the level of its group.

  Background:
    Given the instance "tasks" has the list "Groceries" with the open tasks "milk", "bread" and "eggs"
    And agent 7 belongs to the admin and may read and write

  Rule: The level of a group decides whether an agent can read

    Scenario: An agent reads a list in a group at level read
      Given the admin sets the group "lists" of "tasks" to read
      When agent 7 asks for the open tasks of "Groceries"
      Then agent 7 gets "milk", "bread" and "eggs"

    Scenario: An agent cannot read a list in a group at level none
      Given the admin sets the group "lists" of "tasks" to none
      When agent 7 asks for the open tasks of "Groceries"
      Then agent 7 is told that the admin turned the operation off, and gets no tasks

    Scenario: A change of level applies to the next call
      Given the group "lists" of "tasks" is at level none
      And agent 7 has an open session on "tasks"
      When the admin sets the group "lists" to read
      And agent 7 asks again for the open tasks of "Groceries" in the same session
      Then agent 7 gets "milk", "bread" and "eggs"

  Rule: The level of a group decides whether an agent can change a list

    Scenario: An agent cannot add a task in a group at level read
      Given the admin sets the group "tasks" of "tasks" to read
      When agent 7 adds "butter" to "Groceries"
      Then agent 7 is told that the admin turned the operation off
      And the list "Groceries" still holds the open tasks "milk", "bread" and "eggs"

    Scenario: An add in a group at level ask waits for a human
      Given the admin sets the group "tasks" of "tasks" to ask
      When agent 7 adds "butter" to "Groceries"
      Then agent 7 is told that the call waits for a human to approve it
      And the list "Groceries" still holds the open tasks "milk", "bread" and "eggs"

    Scenario: An add in a group at level write runs without a question
      Given the admin sets the group "tasks" of "tasks" to write
      When agent 7 adds "butter" to "Groceries"
      Then the list "Groceries" holds the open tasks "milk", "bread", "eggs" and "butter"
      And the audit log shows that the level of the group approved the add

  Rule: A write runs without a question only after the admin acknowledges it

    Scenario: A write that nobody acknowledged asks
      Given the admin sets the group "tasks" of "tasks" to write
      And the admin withdraws the acknowledgement of "complete a task"
      When agent 7 completes "milk" in "Groceries"
      Then agent 7 is told that the call waits for a human to approve it
      And the group "tasks" shows 1 operation to acknowledge

    Scenario: Raising a group to write acknowledges its writes
      Given the group "tasks" of "tasks" is at level ask
      When the admin sets the group "tasks" to write
      Then the audit log shows that the admin acknowledged "add a task", "complete a task" and "import tasks"

    Scenario: An own level write acknowledges the operation
      Given the group "tasks" of "tasks" is at level ask
      When the admin gives "complete a task" its own level write
      Then the admin sees that "complete a task" is acknowledged

  Rule: An own level wins over its group, both ways

    Scenario: An own level none closes a write in a group at level write
      Given the admin sets the group "tasks" of "tasks" to write
      And the admin gives "complete a task" its own level none
      When agent 7 completes "milk" in "Groceries"
      Then agent 7 is told that the admin turned the operation off

    Scenario: An own level read opens a read in a group at level none
      Given the admin sets the group "lists" of "tasks" to none
      And the admin gives "show the open tasks" its own level read
      When agent 7 asks for the open tasks of "Groceries"
      Then agent 7 gets "milk", "bread" and "eggs"

    Scenario: Setting the level of a group again clears the own levels in it
      Given the group "lists" of "tasks" is at level none
      And the admin gives "show the open tasks" its own level read
      When the admin sets the group "lists" to none
      Then the admin sees that "show the open tasks" follows its group at level none

  Rule: Each kind of operation takes only its own levels

    Scenario: The admin sees which levels each kind of operation takes
      When the admin looks at the operations of "tasks"
      Then the admin can give "show the open tasks" only the levels none, read and ask
      And the admin can give "add a task" only the levels none, ask and write
      And the admin can give "delete a list" only the levels none and ask

    Scenario: The admin cannot give a write the level read
      When the admin tries to give "add a task" its own level read
      Then the admin is told that "add a task" takes only none, ask or write
      And the admin sees that "add a task" follows its group at level ask

    @backlog
    Scenario: A stored level that does not fit its operation is narrowed
      Given the stored own level of "delete a list" is write
      When agent 7 deletes the list "Groceries"
      Then agent 7 is told that the call waits for a human to approve it

  Rule: A read with its own level ask asks each time

    Scenario: A read at its own level ask asks even a read-only credential
      Given the admin sets the group "lists" of "tasks" to read
      And the admin gives "show the open tasks" its own level ask
      And the admin gave agent 7 a read-only credential instead
      When agent 7 asks for the open tasks of "Groceries"
      Then agent 7 is told that the call waits for a human to approve it

    Scenario: The other reads of the group still run
      Given the admin gives "show the open tasks" its own level ask
      When agent 7 counts the open tasks of "Groceries"
      Then agent 7 is told that "Groceries" has 3 open tasks

    Scenario: A read at its own level ask asks again after an approval
      Given the admin gives "show the open tasks" its own level ask
      And agent 7 asked for the open tasks of "Groceries" and the admin approved it
      When agent 7 asks again for the open tasks of "Groceries" in the same session
      Then agent 7 is told that the call waits for a human to approve it

  Rule: A locked operation runs only with its own level ask

    Scenario: A locked operation stays off in a group at level write
      Given the admin sets the group "lists" of "tasks" to write
      When agent 7 deletes the list "Groceries"
      Then agent 7 is told that the operation is protected and the admin has not enabled it
      And the list "Groceries" still holds the open tasks "milk", "bread" and "eggs"

    Scenario: A locked operation at its own level ask needs a typed confirmation
      Given the admin gives "delete a list" its own level ask
      When agent 7 deletes the list "Groceries"
      Then the approval page asks the admin to type "Groceries" to approve

    Scenario: The admin cannot give a locked operation the level write
      When the admin tries to give "delete a list" its own level write
      Then the admin is told that "delete a list" is locked and always asks

  Rule: A missing group or an unknown level hides the operation

    @backlog
    Scenario: An operation without its group is hidden
      Given the group of "show the open tasks" is missing
      When agent 7 asks for the open tasks of "Groceries"
      Then agent 7 is told that the operation is not available on "tasks"

    @backlog
    Scenario: A group at a level core does not know hides its operations
      Given the group "lists" of "tasks" is stored at the level "everything"
      When agent 7 asks for the open tasks of "Groceries"
      Then agent 7 is told that the operation is not available on "tasks"

    @backlog
    Scenario: An own level core does not know closes the operation
      Given the stored own level of "show the open tasks" is "everything"
      When agent 7 asks for the open tasks of "Groceries"
      Then agent 7 is told that the admin turned the operation off, and gets no tasks

  Rule: A read-only credential never writes

    Scenario: A read-only credential cannot add a task
      Given the admin sets the group "tasks" of "tasks" to write
      And the admin gave agent 7 a read-only credential instead
      When agent 7 adds "butter" to "Groceries"
      Then agent 7 is told that its credential has read-only access
      And the list "Groceries" still holds the open tasks "milk", "bread" and "eggs"

    Scenario: A read-only credential cannot delete a list at its own level ask
      Given the admin gives "delete a list" its own level ask
      And the admin gave agent 7 a read-only credential instead
      When agent 7 deletes the list "Groceries"
      Then agent 7 is told that its credential has read-only access

    Scenario: A write at level none tells a read-only credential that it is off
      Given the admin sets the group "tasks" of "tasks" to none
      And the admin gave agent 7 a read-only credential instead
      When agent 7 adds "butter" to "Groceries"
      Then agent 7 is told that the admin turned the operation off

  Rule: New groups and new credentials start careful

    Scenario: A new group lets reads run
      When agent 7 asks for the open tasks of "Groceries"
      Then agent 7 gets "milk", "bread" and "eggs"

    Scenario: A new group asks before a write
      When agent 7 adds "butter" to "Groceries"
      Then agent 7 is told that the call waits for a human to approve it

    Scenario: A new credential is read-only unless the admin picks read and write
      Given the admin sets the group "tasks" of "tasks" to write
      And the admin makes a credential for agent 7b and keeps the access it offers
      When agent 7b adds "butter" to "Groceries"
      Then agent 7b is told that its credential has read-only access
