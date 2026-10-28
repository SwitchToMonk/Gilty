package com.onegit;

/** 2x1 contribution heatmap with no text at all - just the graph, filling the
 *  whole widget. Same accent palette and same refresh schedule as the others. */
public class ContributionGraph2x1 extends ContributionWidget {

    { weeksLimit = 26; small = true; graphOnly = true; cell = 9; gap = 3; }

    @Override
    protected int layoutId() { return R.layout.widget_contrib_graph_2x1; }
}
