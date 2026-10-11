fun onResult(won: Boolean) {
    listOf(won).forEach { x -> capture("kotlin_lambda") }
    when (won) {
        true -> capture("kotlin_when_true")
        else -> capture("kotlin_when_else")
    }
    analytics.capture("kotlin_member")
}
